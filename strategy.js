import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// Get directory path
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Strategy module for analyzing past performance and calculating price adjustments
 */
class PricingStrategy {
  constructor() {
    this.config = null;
    this.logs = [];
    this.propertyStats = new Map(); // Store stats by property URL
    this.currentChanges = []; // Track changes for the current run
  }

  /**
   * Initialize the strategy module with configuration
   * @param {Object} config - Configuration object
   */
  async initialize(config) {
    this.config = config;
    
    // Load historical logs
    try {
      if (await this.fileExists(config.logFile)) {
        const logData = JSON.parse(await fs.readFile(config.logFile, "utf8"));
        // If the file has multiple runs, take all the changes
        if (Array.isArray(logData)) {
          this.logs = logData.flatMap(run => Array.isArray(run.changes) ? run.changes : []);
          console.log(`Loaded ${this.logs.length} historical data points from ${logData.length} runs`);
        } else {
          // Legacy format with single run
          this.logs = Array.isArray(logData.changes) ? logData.changes : [];
          console.log(`Loaded ${this.logs.length} historical data points from single run`);
        }
        
        // Process logs to extract property stats
        this.analyzeHistoricalData();
      }
    } catch (error) {
      console.error("Error loading historical data:", error.message);
    }
    
    return this;
  }
  
  /**
   * Check if a file exists
   * @param {string} filePath - Path to the file
   * @returns {Promise<boolean>} - Whether the file exists
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Analyze historical data to extract property performance metrics
   */
  analyzeHistoricalData() {
    // Group logs by property URL
    for (const entry of this.logs) {
      if (entry.error) continue; // Skip entries with errors
      
      const url = entry.url;
      if (!this.propertyStats.has(url)) {
        this.propertyStats.set(url, {
          url,
          occupancyHistory: [],
          priceHistory: [],
          adjustmentHistory: [], // Initialize adjustment history array
          lastUpdate: null
        });
      }
      
      const stats = this.propertyStats.get(url);
      
      // Add occupancy data if available
      if (entry.occupancy) {
        stats.occupancyHistory.push({
          date: entry.date,
          sevenDay: this.parseOccupancyRate(entry.occupancy["7_day_occ"]),
          thirtyDay: this.parseOccupancyRate(entry.occupancy["30_day_occ"]),
          sixtyDay: this.parseOccupancyRate(entry.occupancy["60_day_occ"])
        });
      }
      
      // Add price data if available
      if (entry.minPrice && entry.basePrice) {
        const priceEntry = {
          date: entry.date,
          minPrice: {
            before: entry.minPrice.before,
            after: entry.minPrice.after
          },
          basePrice: {
            before: entry.basePrice.before,
            after: entry.basePrice.after
          }
        };
        
        stats.priceHistory.push(priceEntry);
        
        // Calculate and record adjustment percentages
        if (entry.minPrice.before > 0 && entry.basePrice.before > 0) {
          const minPricePercentChange = ((entry.minPrice.after - entry.minPrice.before) / entry.minPrice.before) * 100;
          const basePricePercentChange = ((entry.basePrice.after - entry.basePrice.before) / entry.basePrice.before) * 100;
          
          // Determine strategy from price changes
          let strategy = "hold";
          if (minPricePercentChange > 0.5 || basePricePercentChange > 0.5) {
            strategy = "increase";
          } else if (minPricePercentChange < -0.5 || basePricePercentChange < -0.5) {
            strategy = "decrease";
          }
          
          stats.adjustmentHistory.push({
            date: entry.date,
            strategy: strategy,
            minPricePercentChange: minPricePercentChange,
            basePricePercentChange: basePricePercentChange
          });
        }
      }
      
      // Update last updated date
      if (!stats.lastUpdate || new Date(entry.date) > new Date(stats.lastUpdate)) {
        stats.lastUpdate = entry.date;
      }
    }
    
    console.log(`Analyzed data for ${this.propertyStats.size} properties`);
  }
  
  /**
   * Parse occupancy rate from string to decimal (0.25 instead of "25%")
   * @param {string} rateStr - Occupancy rate as string (e.g., "85%")
   * @returns {number} - Occupancy rate as decimal (0-1)
   */
  parseOccupancyRate(rateStr) {
    // If null, undefined, "N/A" or empty string, return 0 (not null)
    if (rateStr === null || rateStr === undefined || rateStr === "N/A" || rateStr === "") {
      return 0; // Treat N/A as 0% occupancy
    }
    
    if (typeof rateStr === "number") {
      // Already a number, just ensure it's in decimal form (0-1 range)
      return rateStr > 1 ? rateStr / 100 : rateStr;
    }
    
    if (typeof rateStr !== "string") return 0;
    
    const match = rateStr.match(/(\d+(\.\d+)?)%?/);
    if (!match) return 0;
    
    // Convert to decimal (divide by 100)
    return parseFloat(match[1]) / 100;
  }
  
  /**
   * Get property-specific strategy based on historical performance
   * @param {string} propertyUrl - URL of the property
   * @param {Object} currentOccupancy - Current occupancy rates
   * @returns {string} - Strategy to use: "increase", "decrease", or "hold"
   */
  getPropertyStrategy(propertyUrl, currentOccupancy) {
    // Use global strategy as default
    let strategy = this.config.strategy;
    
    // Parse occupancy rates - now treating N/A as 0%
    const current7DayOcc = this.parseOccupancyRate(currentOccupancy["7_day_occ"]);
    const current30DayOcc = this.parseOccupancyRate(currentOccupancy["30_day_occ"]);
    const current60DayOcc = this.parseOccupancyRate(currentOccupancy["60_day_occ"]);
    
    // Get weights from config or use defaults if not specified
    const weights = this.config.occupancyWeights || { sevenDay: 0.6, thirtyDay: 0.3, sixtyDay: 0.1 };
    
    // Get thresholds from config or use defaults if not specified
    const thresholds = this.config.occupancyThresholds || { 
      high: 0.85, 
      medium: 0.50, 
      low: 0.40, 
      critical: 0.20 
    };
    
    // Calculate weighted average of all time periods
    const weightedOcc = (current7DayOcc * weights.sevenDay) + 
                        (current30DayOcc * weights.thirtyDay) + 
                        (current60DayOcc * weights.sixtyDay);
    
    // Log the occupancy rates and weights we're using
    console.log(`Strategy analysis for ${propertyUrl}:`);
    console.log(`  7-day occupancy: ${(current7DayOcc * 100).toFixed(2)}% (weight: ${weights.sevenDay})`);
    console.log(`  30-day occupancy: ${(current30DayOcc * 100).toFixed(2)}% (weight: ${weights.thirtyDay})`);
    console.log(`  60-day occupancy: ${(current60DayOcc * 100).toFixed(2)}% (weight: ${weights.sixtyDay})`);
    console.log(`  Weighted occupancy: ${(weightedOcc * 100).toFixed(2)}%`);
    
    // First check if we should force a HOLD based on recent adjustment history
    let forceHold = false;
    let consecutiveIncreases = 0;
    let consecutiveDecreases = 0;
    let cumulativeIncrease = 0;
    let cumulativeDecrease = 0;
    
    // Check for recent price increases over the last 7 days
    let sevenDayIncrease = 0;
    let sevenDayDecrease = 0;
    
    if (this.propertyStats.has(propertyUrl)) {
      const stats = this.propertyStats.get(propertyUrl);
      
      if (stats.adjustmentHistory && stats.adjustmentHistory.length > 0) {
        // Get recent adjustment history
        const recentAdjustments = stats.adjustmentHistory.slice(-7); // Last 7 adjustments
        
        // Start from most recent and go backwards
        for (let i = recentAdjustments.length - 1; i >= 0; i--) {
          const adjustment = recentAdjustments[i];
          
          // Check if the adjustment was within the last 7 days
          const adjustmentDate = new Date(adjustment.date);
          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
          
          if (adjustmentDate >= sevenDaysAgo) {
            // Add to 7-day totals for the 5% cap check
            if (adjustment.basePricePercentChange > 0) {
              sevenDayIncrease += adjustment.basePricePercentChange;
            } else if (adjustment.basePricePercentChange < 0) {
              sevenDayDecrease += Math.abs(adjustment.basePricePercentChange);
            }
          }
          
          if (adjustment.strategy === "increase" && 
              (adjustment.minPricePercentChange > 0 || adjustment.basePricePercentChange > 0)) {
            consecutiveIncreases++;
            cumulativeIncrease += Math.max(adjustment.minPricePercentChange, adjustment.basePricePercentChange);
            // Break chain if we encounter something else
            if (consecutiveDecreases > 0) break;
          } 
          else if (adjustment.strategy === "decrease" && 
                  (adjustment.minPricePercentChange < 0 || adjustment.basePricePercentChange < 0)) {
            consecutiveDecreases++;
            cumulativeDecrease += Math.abs(Math.min(adjustment.minPricePercentChange, adjustment.basePricePercentChange));
            // Break chain if we encounter something else
            if (consecutiveIncreases > 0) break;
          } 
          else {
            // Break the chain on hold or inconsistent strategy
            break;
          }
        }
        
        console.log(`  Recent adjustment history: ${consecutiveIncreases} consecutive increases (${cumulativeIncrease.toFixed(1)}% total), ${consecutiveDecreases} consecutive decreases (${cumulativeDecrease.toFixed(1)}% total)`);
        console.log(`  Last 7-day price changes: +${sevenDayIncrease.toFixed(1)}%, -${sevenDayDecrease.toFixed(1)}%`);
        
        // Force hold if we've had any increase in the last 7 days totaling 3% or more
        // (lowering from 4% to be more conservative)
        if (cumulativeIncrease >= 3) {
          console.log(`  Forcing HOLD strategy after increases totaling ${cumulativeIncrease.toFixed(1)}% (>=3% threshold)`);
          forceHold = true;
        }
        
        // Force hold if we've increased by 4% or more in the last 7 days
        if (sevenDayIncrease >= 4) {
          console.log(`  Forcing HOLD strategy after 7-day increases totaling ${sevenDayIncrease.toFixed(1)}% (>=4% threshold)`);
          forceHold = true;
        }
        
        // Force hold after 3 consecutive decreases
        if (consecutiveDecreases >= 3) {
          console.log(`  Forcing HOLD strategy after ${consecutiveDecreases} consecutive decreases totaling ${cumulativeDecrease.toFixed(1)}%`);
          forceHold = true;
        }
      }
    }
    
    // If we're forcing a hold due to consecutive adjustments, return early
    if (forceHold) {
      return "hold";
    }
    
    // Now determine the appropriate strategy based on occupancy
    if (current7DayOcc >= thresholds.high) {
      console.log(`  HIGH OCCUPANCY DETECTED (${(current7DayOcc * 100).toFixed(1)}% ≥ ${thresholds.high*100}%)`);
      strategy = "increase";
    } else if (weightedOcc < thresholds.low && current7DayOcc < thresholds.medium) {
      console.log(`  LOW OCCUPANCY DETECTED (${(weightedOcc * 100).toFixed(1)}% < ${thresholds.low*100}%)`);
      strategy = "decrease";
    } else if (this.propertyStats.has(propertyUrl)) {
      // If we have historical data for this property, refine strategy
      const stats = this.propertyStats.get(propertyUrl);
      
      // Get recent occupancy trend
      const occupancyTrend = this.calculateOccupancyTrend(stats.occupancyHistory);
      console.log(`  Occupancy trend: ${occupancyTrend.toFixed(2)} percentage points`);
      
      // Switch strategy based on occupancy trends and current rates
      if (occupancyTrend > 5 || current7DayOcc > 0.7) {
        // Occupancy increasing significantly or high - increase prices
        strategy = "increase";
      } else if (occupancyTrend < -3 || weightedOcc < 0.45) {
        // Occupancy decreasing significantly or generally low - decrease prices
        strategy = "decrease";
      } else {
        // Stable occupancy in a good range - maintain current pricing with small oscillations
        strategy = "hold";
      }
    }
    
    console.log(`  Selected strategy: ${strategy}`);
    return strategy;
  }
  
  /**
   * Calculate the trend in occupancy rates (percentage points change)
   * @param {Array} occupancyHistory - History of occupancy rates
   * @returns {number} - Trend as percentage points change
   */
  calculateOccupancyTrend(occupancyHistory) {
    if (!occupancyHistory || occupancyHistory.length < 2) return 0;
    
    // Sort by date, most recent first
    const sorted = [...occupancyHistory].sort((a, b) => 
      new Date(b.date) - new Date(a.date)
    );
    
    // Get most recent and previous 7-day occupancy rates
    const mostRecent = sorted[0].sevenDay;
    const previous = sorted[1].sevenDay;
    
    // If we don't have valid data, return 0 (no trend)
    if (mostRecent === null || previous === null) return 0;
    
    // Return the difference as percentage points (multiply by 100 for percentage points)
    return (mostRecent - previous) * 100;
  }
  
  /**
   * Calculate adjusted price based on strategy and property history
   * @param {string} propertyUrl - URL of the property
   * @param {number} currentPrice - Current price value
   * @param {Object} currentOccupancy - Current occupancy rates
   * @param {string} priceType - Type of price ("min" or "base")
   * @returns {number} - Adjusted price
   */
  calculateAdjustedPrice(propertyUrl, currentPrice, currentOccupancy, priceType) {
    // Get appropriate strategy for this property
    const strategy = this.getPropertyStrategy(propertyUrl, currentOccupancy);
    
    // Parse occupancy rates for calculations - now treating N/A as 0%
    const sevenDayOcc = this.parseOccupancyRate(currentOccupancy["7_day_occ"]);
    const thirtyDayOcc = this.parseOccupancyRate(currentOccupancy["30_day_occ"]);
    const sixtyDayOcc = this.parseOccupancyRate(currentOccupancy["60_day_occ"]);
    
    // Get weights from config or use defaults if not specified
    const weights = this.config.occupancyWeights || { sevenDay: 0.6, thirtyDay: 0.3, sixtyDay: 0.1 };
    
    // Get thresholds from config or use defaults if not specified
    const thresholds = this.config.occupancyThresholds || { 
      high: 0.85, 
      medium: 0.50, 
      low: 0.40, 
      critical: 0.20 
    };
    
    // Calculate weighted average occupancy
    const weightedOcc = (sevenDayOcc * weights.sevenDay) + 
                        (thirtyDayOcc * weights.thirtyDay) + 
                        (sixtyDayOcc * weights.sixtyDay);
    
    // Determine adjustment percentage based on strategy and occupancy levels
    let adjustmentPercentage = 0;
    const dayOfWeek = new Date().getDay();
    
    // Check for 7-day price change limits
    let sevenDayIncrease = 0;
    
    // Get property stats for tracking oscillation direction
    let lastOscillationDirection = null;
    
    if (this.propertyStats.has(propertyUrl)) {
      const stats = this.propertyStats.get(propertyUrl);
      
      // Get the last oscillation direction if it exists
      if (stats.lastOscillationDirection !== undefined) {
        lastOscillationDirection = stats.lastOscillationDirection;
      }
      
      if (stats.adjustmentHistory && stats.adjustmentHistory.length > 0) {
        // Calculate total price increases over the past 7 days
        const now = new Date();
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(now.getDate() - 7);
        
        for (const adjustment of stats.adjustmentHistory) {
          const adjustmentDate = new Date(adjustment.date);
          if (adjustmentDate >= sevenDaysAgo) {
            // Add positive changes to the total
            const changeToUse = priceType === "min" ? 
              adjustment.minPricePercentChange : 
              adjustment.basePricePercentChange;
            
            if (changeToUse > 0) {
              sevenDayIncrease += changeToUse;
            }
          }
        }
      }
    }
    
    switch (strategy) {
      case "increase":
        // Progressive increases based on occupancy level
        if (sevenDayOcc >= 0.95) { // 95%+ occupancy
          // Very high occupancy - significant increase
          adjustmentPercentage = this.config.adjustments.increase.percentage * 1.5;
          console.log(`  VERY HIGH occupancy (${(sevenDayOcc * 100).toFixed(1)}%) - applying ${adjustmentPercentage.toFixed(1)}% increase`);
        } else if (sevenDayOcc >= thresholds.high) { // High occupancy threshold
          // High occupancy - moderate increase
          adjustmentPercentage = this.config.adjustments.increase.percentage * 1.2;
          console.log(`  HIGH occupancy (${(sevenDayOcc * 100).toFixed(1)}%) - applying ${adjustmentPercentage.toFixed(1)}% increase`);
        } else {
          // Normal increase
          adjustmentPercentage = this.config.adjustments.increase.percentage;
          console.log(`  Standard increase - applying ${adjustmentPercentage.toFixed(1)}%`);
        }
        
        // Cap price increases to 5% in 7 days
        if (sevenDayIncrease + adjustmentPercentage > 5) {
          const newAdjustment = Math.max(0, 5 - sevenDayIncrease);
          console.log(`  CAPPING INCREASE: Total 7-day increases of ${sevenDayIncrease.toFixed(1)}% + planned ${adjustmentPercentage.toFixed(1)}% would exceed 5% cap`);
          console.log(`  Reducing adjustment from ${adjustmentPercentage.toFixed(1)}% to ${newAdjustment.toFixed(1)}%`);
          adjustmentPercentage = newAdjustment;
          
          // If adjustment would be less than 1%, oscillate down 1% instead of hold
          if (adjustmentPercentage < 1) {
            console.log(`  Adjustment would be too small (${adjustmentPercentage.toFixed(1)}%), switching to -1% oscillation instead of HOLD`);
            adjustmentPercentage = -1.0;
          }
        }
        break;
      
      case "decrease":
        // Progressive decreases based on how low occupancy is
        if (weightedOcc < thresholds.critical) { // Extremely low occupancy across all periods
          // Critical low occupancy - aggressive decrease
          adjustmentPercentage = -this.config.adjustments.decrease.percentage * 1.5;
          console.log(`  CRITICALLY LOW occupancy (${(weightedOcc * 100).toFixed(1)}%) - applying ${Math.abs(adjustmentPercentage).toFixed(1)}% decrease`);
        } else if (sevenDayOcc < 0.30 && thirtyDayOcc < thresholds.low) {
          // Very low occupancy - strong decrease
          adjustmentPercentage = -this.config.adjustments.decrease.percentage * 1.2;
          console.log(`  VERY LOW occupancy (${(sevenDayOcc * 100).toFixed(1)}%) - applying ${Math.abs(adjustmentPercentage).toFixed(1)}% decrease`);
        } else {
          // Standard decrease
          adjustmentPercentage = -this.config.adjustments.decrease.percentage;
          console.log(`  LOW occupancy (${(sevenDayOcc * 100).toFixed(1)}%) - applying ${Math.abs(adjustmentPercentage).toFixed(1)}% decrease`);
        }
        break;
      
      case "hold":
        // Only apply oscillation if occupancy is in a healthy range
        if (weightedOcc >= thresholds.low && weightedOcc <= thresholds.high) {
          const baseOsc = this.config.adjustments.hold.oscillationPercentage;
          
          // Determine oscillation direction based on previous oscillation
          let oscillationDirection = 1;  // Default to upward
          
          // If we have a previous oscillation, do the opposite
          if (lastOscillationDirection !== null) {
            oscillationDirection = lastOscillationDirection > 0 ? -1 : 1;
            console.log(`  Using opposite direction of last oscillation (${lastOscillationDirection > 0 ? "up" : "down"})`);
          }
          
          // Adjust oscillation magnitude based on weekend
          const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
          const oscillationMagnitude = isWeekend ? 
            (oscillationDirection > 0 ? baseOsc * 1.2 : baseOsc * 0.8) : 
            baseOsc;
          
          // Calculate the adjustment with the correct direction
          adjustmentPercentage = oscillationDirection * oscillationMagnitude;
          
          // Cap any positive adjustment during HOLD if we're near 5% in 7 days
          if (adjustmentPercentage > 0 && sevenDayIncrease + adjustmentPercentage > 4.5) {
            adjustmentPercentage = -1.0; // Force a downward oscillation
            console.log(`  HOLD oscillation changed to -1% - already near 7-day increase limit`);
          } else {
            console.log(`  HOLD strategy - applying ${adjustmentPercentage > 0 ? "+" : ""}${adjustmentPercentage.toFixed(1)}% oscillation`);
          }
          
          // Store this oscillation direction for next time
          if (this.propertyStats.has(propertyUrl)) {
            const stats = this.propertyStats.get(propertyUrl);
            stats.lastOscillationDirection = adjustmentPercentage;
          }
        } else if (weightedOcc < thresholds.low) {
          // Even though strategy is "hold", occupancy is too low, so decrease
          adjustmentPercentage = -this.config.adjustments.decrease.percentage * 0.7;
          console.log(`  HOLD strategy overridden due to low occupancy (${(weightedOcc * 100).toFixed(1)}%) - applying ${Math.abs(adjustmentPercentage).toFixed(1)}% decrease`);
        } else {
          // Even though strategy is "hold", occupancy is high, so increase
          // But make sure we don't exceed 5% in 7 days
          adjustmentPercentage = this.config.adjustments.increase.percentage * 0.7;
          
          if (sevenDayIncrease + adjustmentPercentage > 5) {
            const newAdjustment = Math.max(0, 5 - sevenDayIncrease);
            console.log(`  CAPPING HOLD INCREASE: Total 7-day increases of ${sevenDayIncrease.toFixed(1)}% + planned ${adjustmentPercentage.toFixed(1)}% would exceed 5% cap`);
            console.log(`  Reducing adjustment from ${adjustmentPercentage.toFixed(1)}% to ${newAdjustment.toFixed(1)}%`);
            adjustmentPercentage = newAdjustment;
          } else {
            console.log(`  HOLD strategy overridden due to high occupancy (${(weightedOcc * 100).toFixed(1)}%) - applying ${adjustmentPercentage.toFixed(1)}% increase`);
          }
        }
        break;
      
      default:
        console.log("  No valid strategy found, making no changes");
        return currentPrice;
    }
    
    // Calculate the adjustment
    const adjustment = currentPrice * (adjustmentPercentage / 100);
    const adjustedPrice = Math.round(currentPrice + adjustment);
    
    console.log(`  Price adjustment: ${currentPrice} -> ${adjustedPrice} (${adjustmentPercentage > 0 ? "+" : ""}${adjustmentPercentage.toFixed(1)}%)`);
    
    // Store this adjustment
    if (this.propertyStats.has(propertyUrl)) {
      const stats = this.propertyStats.get(propertyUrl);
      
      if (!stats.adjustmentHistory) {
        stats.adjustmentHistory = [];
      }
      
      // Record this adjustment
      stats.adjustmentHistory.push({
        date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
        strategy: strategy,
        percentChange: adjustmentPercentage,
        minPricePercentChange: priceType === "min" ? adjustmentPercentage : 0,
        basePricePercentChange: priceType === "base" ? adjustmentPercentage : 0
      });
      
      // Add to the current run's changes
      const existingChange = this.currentChanges.find(change => change.url === propertyUrl);
      
      if (existingChange) {
        // Update existing change
        if (priceType === "min") {
          existingChange.minPrice = {
            before: currentPrice,
            after: adjustedPrice
          };
        } else if (priceType === "base") {
          existingChange.basePrice = {
            before: currentPrice,
            after: adjustedPrice
          };
        }
      } else {
        // Create new change
        const changeEntry = {
          url: propertyUrl,
          date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
          occupancy: currentOccupancy
        };
        
        if (priceType === "min") {
          changeEntry.minPrice = {
            before: currentPrice,
            after: adjustedPrice
          };
        } else if (priceType === "base") {
          changeEntry.basePrice = {
            before: currentPrice,
            after: adjustedPrice
          };
        }
        
        this.currentChanges.push(changeEntry);
      }
    }
    
    // For min price, ensure it's at least 20% below base price if this is a min price adjustment
    if (priceType === "min" && this.propertyStats.has(propertyUrl)) {
      const stats = this.propertyStats.get(propertyUrl);
      if (stats.priceHistory.length > 0) {
        const recentPrices = stats.priceHistory[0];
        const recentBasePrice = recentPrices.basePrice.after;
        
        // Ensure min price is at least 20% below base price
        const minAllowedPrice = Math.round(recentBasePrice * 0.8);
        if (adjustedPrice > minAllowedPrice) {
          console.log(`  Capping min price to ensure it's at least 20% below base price: ${adjustedPrice} -> ${minAllowedPrice}`);
          return minAllowedPrice;
        }
      }
    }
    
    return adjustedPrice;
  }
  
  /**
   * Save current changes to the JSON file
   * @returns {Promise<void>}
   */
  async saveChanges() {
    try {
      if (!this.config || !this.config.logFile) {
        console.error("Cannot save changes: No log file specified in config");
        return;
      }
      
      // If there are no changes to save, don't bother
      if (this.currentChanges.length === 0) {
        console.log("No changes to save from strategy module");
        return;
      }
      
      console.log(`Strategy module saving ${this.currentChanges.length} changes to ${this.config.logFile}`);
      
      // Read existing data
      let existingData = { lastRun: new Date().toISOString().split('T')[0], changes: [] };
      
      try {
        if (await this.fileExists(this.config.logFile)) {
          const fileData = await fs.readFile(this.config.logFile, "utf8");
          existingData = JSON.parse(fileData);
          
          // Ensure existingData has the right structure
          if (Array.isArray(existingData)) {
            // Format is an array of runs, use the most recent one
            if (existingData.length > 0) {
              // Convert from array format to single object format for now
              // This maintains compatibility with the index.js saveChangesToLog function
              existingData = existingData[0];
            } else {
              existingData = { lastRun: new Date().toISOString().split('T')[0], changes: [] };
            }
          } else if (!existingData.changes) {
            existingData.changes = [];
          }
        } else {
          console.log(`Log file ${this.config.logFile} doesn't exist yet. Creating new file.`);
        }
      } catch (error) {
        console.error("Error reading existing data, starting fresh:", error.message);
      }
      
      // Set lastRun to today
      existingData.lastRun = new Date().toISOString().split('T')[0];
      
      // Add new changes to the beginning of the array
      if (!Array.isArray(existingData.changes)) {
        existingData.changes = [];
      }
      
      // Add current changes to the existing data
      existingData.changes = [...this.currentChanges, ...existingData.changes];
      
      // Write back to file
      await fs.writeFile(
        this.config.logFile,
        JSON.stringify(existingData, null, 2),
        "utf8"
      );
      
      console.log(`Strategy module successfully saved changes to ${this.config.logFile}`);
      
      // Clear current changes after saving
      this.currentChanges = [];
      
    } catch (error) {
      console.error("Error saving changes:", error.message);
    }
  }
}

export default PricingStrategy; 