import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import PricingStrategy from "./strategy.js";

// Get directory path
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load configuration
const config = JSON.parse(await fs.readFile(path.join(__dirname, "config.json"), "utf8"));

/**
 * Simulation of property performance over time
 */
class PricingSimulation {
  constructor() {
    this.properties = [];
    this.simulationResults = {};
    this.simulationDays = 90;
    this.strategy = null;
  }
  
  /**
   * Initialize the simulation
   */
  async initialize() {
    // Initialize strategy module
    this.strategy = await new PricingStrategy().initialize(config);
    
    // Create properties with different profiles
    this.properties = [
      {
        id: "high-demand-property",
        name: "High Demand Beachfront",
        url: "https://app.pricelabs.co/pricing?listings=high-demand-property",
        basePrice: 250,
        minPrice: 175,
        occupancy: 0.70, // Starting at 70% occupancy
        elasticity: 0.8, // How sensitive occupancy is to price changes (higher = more sensitive)
        seasonality: 0.15, // Amplitude of seasonal variation
        weekendPremium: 0.25, // How much more people book on weekends
        randomVariation: 0.05, // Random variation in day-to-day bookings
        baselineBookingProbability: 0.12 // Baseline probability of new bookings each day
      },
      {
        id: "mid-demand-property",
        name: "Mid-Range Downtown",
        url: "https://app.pricelabs.co/pricing?listings=mid-demand-property",
        basePrice: 150,
        minPrice: 100,
        occupancy: 0.50, // Starting at 50% occupancy
        elasticity: 1.0, 
        seasonality: 0.10,
        weekendPremium: 0.20,
        randomVariation: 0.08,
        baselineBookingProbability: 0.09
      },
      {
        id: "low-demand-property",
        name: "Low Demand Suburban",
        url: "https://app.pricelabs.co/pricing?listings=low-demand-property",
        basePrice: 100,
        minPrice: 70,
        occupancy: 0.30, // Starting at 30% occupancy
        elasticity: 1.2, // More sensitive to price changes
        seasonality: 0.05,
        weekendPremium: 0.10,
        randomVariation: 0.10,
        baselineBookingProbability: 0.06
      }
    ];
    
    // Initialize simulation results structure
    for (const property of this.properties) {
      this.simulationResults[property.id] = {
        property: property,
        days: []
      };
    }
    
    return this;
  }
  
  /**
   * Run the simulation for all properties over the specified number of days
   */
  async runSimulation() {
    console.log(`Starting simulation for ${this.simulationDays} days...`);
    
    const startDate = new Date();
    
    // For each day in the simulation
    for (let day = 0; day < this.simulationDays; day++) {
      const simulationDate = new Date(startDate);
      simulationDate.setDate(startDate.getDate() + day);
      const dateString = simulationDate.toISOString().split("T")[0];
      const dayOfWeek = simulationDate.getDay(); // 0-6
      const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
      
      console.log(`\nSimulating day ${day + 1}/${this.simulationDays}: ${dateString} (${isWeekend ? "Weekend" : "Weekday"})`);
      
      // Process each property
      for (const property of this.properties) {
        // Get property simulation data
        const simData = this.simulationResults[property.id];
        const prevDay = simData.days.length > 0 ? simData.days[simData.days.length - 1] : null;
        
        // Calculate current occupancy metrics
        let sevenDayOcc, thirtyDayOcc, sixtyDayOcc;
        
        if (day === 0) {
          // Initial day - use property's default occupancy
          sevenDayOcc = property.occupancy;
          thirtyDayOcc = property.occupancy;
          sixtyDayOcc = property.occupancy;
        } else {
          // Calculate from previous days
          const last7Days = simData.days.slice(-7);
          const last30Days = simData.days.slice(-30);
          const last60Days = simData.days.slice(-60);
          
          sevenDayOcc = last7Days.reduce((sum, d) => sum + d.dailyOccupancy, 0) / last7Days.length;
          thirtyDayOcc = last30Days.reduce((sum, d) => sum + d.dailyOccupancy, 0) / last30Days.length;
          sixtyDayOcc = last60Days.length > 0 
            ? last60Days.reduce((sum, d) => sum + d.dailyOccupancy, 0) / last60Days.length 
            : sevenDayOcc;
        }
        
        // Current occupancy metrics for strategy calculation
        const currentOccupancy = {
          "7_day_occ": sevenDayOcc,
          "30_day_occ": thirtyDayOcc,
          "60_day_occ": sixtyDayOcc
        };
        
        // Current prices (from previous day or initial)
        const currentBasePrice = prevDay ? prevDay.basePrice : property.basePrice;
        const currentMinPrice = prevDay ? prevDay.minPrice : property.minPrice;
        
        // Calculate new prices using strategy
        const newBasePrice = this.strategy.calculateAdjustedPrice(
          property.url, 
          currentBasePrice, 
          currentOccupancy, 
          "base"
        );
        
        const newMinPrice = this.strategy.calculateAdjustedPrice(
          property.url, 
          currentMinPrice, 
          currentOccupancy, 
          "min"
        );
        
        // Calculate new daily occupancy based on price changes, seasonality, etc.
        const newDailyOccupancy = this.calculateNewOccupancy(
          property,
          prevDay ? prevDay.dailyOccupancy : property.occupancy,
          currentBasePrice,
          newBasePrice,
          dateString,
          dayOfWeek
        );
        
        // Store the day's results
        simData.days.push({
          day: day + 1,
          date: dateString,
          dayOfWeek,
          isWeekend,
          basePrice: newBasePrice,
          minPrice: newMinPrice,
          dailyOccupancy: newDailyOccupancy,
          sevenDayOcc,
          thirtyDayOcc,
          sixtyDayOcc,
          priceChangePercent: currentBasePrice ? (newBasePrice - currentBasePrice) / currentBasePrice : 0
        });
        
        console.log(`  ${property.name}: Occupancy: ${(newDailyOccupancy * 100).toFixed(1)}%, Base Price: $${newBasePrice} (${newBasePrice > currentBasePrice ? "+" : ""}${((newBasePrice - currentBasePrice) / currentBasePrice * 100).toFixed(1)}%)`);
      }
    }
    
    // Save simulation results
    await this.saveResults();
    
    return this.simulationResults;
  }
  
  /**
   * Calculate new occupancy rate based on various factors
   * @param {Object} property - Property data
   * @param {number} currentOccupancy - Current occupancy rate
   * @param {number} oldPrice - Previous price
   * @param {number} newPrice - New price
   * @param {string} dateString - Current date
   * @param {number} dayOfWeek - Day of week (0-6)
   * @returns {number} - New occupancy rate
   */
  calculateNewOccupancy(property, currentOccupancy, oldPrice, newPrice, dateString, dayOfWeek) {
    // Price elasticity effect
    const priceRatio = oldPrice > 0 ? newPrice / oldPrice : 1;
    const elasticityEffect = 1 - (priceRatio - 1) * property.elasticity;
    
    // Seasonality effect - simulate peak in summer, lower in winter
    const dayOfYear = new Date(dateString).getTime() / (1000 * 60 * 60 * 24);
    const seasonalPosition = Math.sin((dayOfYear / 365) * 2 * Math.PI);
    const seasonalityEffect = 1 + seasonalPosition * property.seasonality;
    
    // Weekend premium
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    const weekendEffect = isWeekend ? (1 + property.weekendPremium) : 1;
    
    // Random variation - simulate unpredictable market factors
    const randomEffect = 1 + (Math.random() * 2 - 1) * property.randomVariation;
    
    // Calculate booking probability adjusted by all factors
    const adjustedBookingProbability = property.baselineBookingProbability * 
      elasticityEffect * seasonalityEffect * weekendEffect * randomEffect;
    
    // Calculate bookings and cancellations
    const newBookingRate = Math.min(adjustedBookingProbability, 0.30); // Cap at 30% new bookings/day
    const cancellationRate = currentOccupancy * 0.05; // 5% of existing bookings cancel
    
    // Net change in occupancy
    const occupancyChange = newBookingRate - cancellationRate;
    
    // Calculate new occupancy, ensuring it stays between 0-1 (0-100%)
    const newOccupancy = Math.max(0, Math.min(1, currentOccupancy + occupancyChange));
    
    return newOccupancy;
  }
  
  /**
   * Save simulation results to file
   */
  async saveResults() {
    const filename = path.join(__dirname, "simulation_results.json");
    await fs.writeFile(
      filename,
      JSON.stringify(this.simulationResults, null, 2),
      "utf8"
    );
    
    console.log(`\nSimulation complete! Results saved to ${filename}`);
    
    // Also save CSV files for easy graphing
    for (const propertyId in this.simulationResults) {
      const property = this.simulationResults[propertyId];
      const csvFilename = path.join(__dirname, `${propertyId}_simulation.csv`);
      
      // Create CSV header
      let csv = "Day,Date,DayOfWeek,BasePrice,MinPrice,DailyOccupancy,7DayOccupancy,30DayOccupancy,PriceChangePercent\n";
      
      // Add data rows
      for (const day of property.days) {
        csv += `${day.day},${day.date},${day.dayOfWeek},${day.basePrice},${day.minPrice},${day.dailyOccupancy.toFixed(4)},${day.sevenDayOcc.toFixed(4)},${day.thirtyDayOcc.toFixed(4)},${day.priceChangePercent.toFixed(4)}\n`;
      }
      
      await fs.writeFile(csvFilename, csv, "utf8");
      console.log(`CSV data for ${property.property.name} saved to ${csvFilename}`);
    }
    
    // Generate HTML visualization
    await this.generateHtmlVisualization();
  }
  
  /**
   * Generate HTML file with charts for visualization
   */
  async generateHtmlVisualization() {
    const htmlFilename = path.join(__dirname, "simulation_visualization.html");
    
    let html = `
<!DOCTYPE html>
<html>
<head>
  <title>Pricing Strategy Simulation</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .chart-container { display: flex; margin-bottom: 40px; }
    .chart { width: 80%; margin: 0 auto; }
    h1, h2 { text-align: center; }
    .property-container { margin-bottom: 50px; padding: 20px; border: 1px solid #ddd; border-radius: 5px; }
    .summary { margin: 20px 0; padding: 15px; background-color: #f9f9f9; border-radius: 5px; }
    .key-metric { font-weight: bold; }
  </style>
</head>
<body>
  <h1>PriceLabs Pricing Strategy Simulation</h1>
  <p>This visualization shows 90 days of simulated pricing adjustments and occupancy rates.</p>
`;
    
    // Add sections for each property
    for (const propertyId in this.simulationResults) {
      const property = this.simulationResults[propertyId];
      const data = property.days;
      
      // Calculate summary statistics
      const avgOccupancy = data.reduce((sum, d) => sum + d.dailyOccupancy, 0) / data.length;
      const avgBasePrice = data.reduce((sum, d) => sum + d.basePrice, 0) / data.length;
      const totalPriceChange = ((data[data.length-1].basePrice / data[0].basePrice) - 1) * 100;
      const avgPriceChangePerDay = data.reduce((sum, d) => sum + Math.abs(d.priceChangePercent), 0) / data.length * 100;
      
      html += `
  <div class="property-container">
    <h2>${property.property.name}</h2>
    
    <div class="summary">
      <p><span class="key-metric">Average Occupancy:</span> ${(avgOccupancy * 100).toFixed(1)}%</p>
      <p><span class="key-metric">Average Base Price:</span> $${avgBasePrice.toFixed(2)}</p>
      <p><span class="key-metric">Total Price Change:</span> ${totalPriceChange > 0 ? "+" : ""}${totalPriceChange.toFixed(1)}% over 90 days</p>
      <p><span class="key-metric">Average Daily Price Adjustment:</span> ${avgPriceChangePerDay.toFixed(2)}%</p>
    </div>
    
    <div class="chart-container">
      <div class="chart">
        <canvas id="priceChart_${propertyId}"></canvas>
      </div>
    </div>
    
    <div class="chart-container">
      <div class="chart">
        <canvas id="occupancyChart_${propertyId}"></canvas>
      </div>
    </div>
    
    <div class="chart-container">
      <div class="chart">
        <canvas id="combinedChart_${propertyId}"></canvas>
      </div>
    </div>
  </div>
`;
    }
    
    // Add JavaScript for charts
    html += `
  <script>
    // Chart.js configuration
    Chart.defaults.font.size = 14;
    Chart.defaults.color = '#333';
    
    // Function to create charts for each property
    function createCharts() {
      const simulationData = ${JSON.stringify(this.simulationResults)};
      
      for (const propertyId in simulationData) {
        const property = simulationData[propertyId];
        const data = property.days;
        
        // Prepare data
        const labels = data.map(d => d.date);
        const basePrices = data.map(d => d.basePrice);
        const minPrices = data.map(d => d.minPrice);
        const dailyOccupancy = data.map(d => d.dailyOccupancy * 100); // Convert to percentage
        const sevenDayOcc = data.map(d => d.sevenDayOcc * 100);
        const thirtyDayOcc = data.map(d => d.thirtyDayOcc * 100);
        
        // Price Chart
        new Chart(document.getElementById('priceChart_' + propertyId), {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Base Price ($)',
                data: basePrices,
                borderColor: '#4285F4',
                backgroundColor: 'rgba(66, 133, 244, 0.1)',
                fill: false,
                tension: 0.1
              },
              {
                label: 'Min Price ($)',
                data: minPrices,
                borderColor: '#DB4437',
                backgroundColor: 'rgba(219, 68, 55, 0.1)',
                fill: false,
                tension: 0.1
              }
            ]
          },
          options: {
            responsive: true,
            plugins: {
              title: {
                display: true,
                text: 'Price Adjustments Over Time'
              },
              tooltip: {
                mode: 'index',
                intersect: false
              }
            },
            scales: {
              y: {
                title: {
                  display: true,
                  text: 'Price ($)'
                }
              },
              x: {
                title: {
                  display: true,
                  text: 'Date'
                }
              }
            }
          }
        });
        
        // Occupancy Chart
        new Chart(document.getElementById('occupancyChart_' + propertyId), {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Daily Occupancy (%)',
                data: dailyOccupancy,
                borderColor: '#0F9D58',
                backgroundColor: 'rgba(15, 157, 88, 0.1)',
                fill: true,
                tension: 0.1
              },
              {
                label: '7-Day Occupancy (%)',
                data: sevenDayOcc,
                borderColor: '#F4B400',
                backgroundColor: 'rgba(244, 180, 0, 0.1)',
                fill: false,
                tension: 0.1
              },
              {
                label: '30-Day Occupancy (%)',
                data: thirtyDayOcc,
                borderColor: '#673AB7',
                backgroundColor: 'rgba(103, 58, 183, 0.1)',
                fill: false,
                tension: 0.1
              }
            ]
          },
          options: {
            responsive: true,
            plugins: {
              title: {
                display: true,
                text: 'Occupancy Rates Over Time'
              },
              tooltip: {
                mode: 'index',
                intersect: false
              }
            },
            scales: {
              y: {
                title: {
                  display: true,
                  text: 'Occupancy (%)'
                },
                min: 0,
                max: 100
              },
              x: {
                title: {
                  display: true,
                  text: 'Date'
                }
              }
            }
          }
        });
        
        // Combined Chart (Price vs. Occupancy)
        new Chart(document.getElementById('combinedChart_' + propertyId), {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Base Price ($)',
                data: basePrices,
                borderColor: '#4285F4',
                backgroundColor: 'transparent',
                fill: false,
                tension: 0.1,
                yAxisID: 'y-price'
              },
              {
                label: '7-Day Occupancy (%)',
                data: sevenDayOcc,
                borderColor: '#F4B400',
                backgroundColor: 'transparent',
                fill: false,
                tension: 0.1,
                yAxisID: 'y-occupancy'
              }
            ]
          },
          options: {
            responsive: true,
            plugins: {
              title: {
                display: true,
                text: 'Price vs. Occupancy'
              },
              tooltip: {
                mode: 'index',
                intersect: false
              }
            },
            scales: {
              'y-price': {
                type: 'linear',
                display: true,
                position: 'left',
                title: {
                  display: true,
                  text: 'Price ($)'
                }
              },
              'y-occupancy': {
                type: 'linear',
                display: true,
                position: 'right',
                title: {
                  display: true,
                  text: 'Occupancy (%)'
                },
                min: 0,
                max: 100,
                grid: {
                  drawOnChartArea: false
                }
              },
              x: {
                title: {
                  display: true,
                  text: 'Date'
                }
              }
            }
          }
        });
      }
    }
    
    // Create charts when the page loads
    window.onload = createCharts;
  </script>
</body>
</html>
`;
    
    await fs.writeFile(htmlFilename, html, "utf8");
    console.log(`HTML visualization created at ${htmlFilename}`);
  }
}

// Run the simulation
const simulation = await new PricingSimulation().initialize();
await simulation.runSimulation(); 