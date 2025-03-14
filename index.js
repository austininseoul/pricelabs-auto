import puppeteer from "puppeteer";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import PricingStrategy from "./strategy.js";

// Load environment variables
dotenv.config();

// Get config
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  await fs.readFile(path.join(__dirname, "config.json"), "utf8")
);

// Selectors
const SELECTORS = {
  EMAIL: "#user_email",
  PASSWORD: "#password-field",
  SUBMIT: "#new_user > input.btn-red.btn.btn-primary.btn-block.btn-md",
  TABLE_BODY: "#mc-main > div > table > tbody",
  TABLE_ROWS: "#mc-main > div > table > tbody > tr",
  PROPERTY_LINK: "td:nth-child(1) > div > div > a",
  OCCUPANCY_RATES: "#popover-trigger-metric-cell-occupancy > p",
  MIN_PRICE_INPUT: "#rp-min-price-input input",
  BASE_PRICE_INPUT: "#rp-base-price-input input",
  SAVE_BUTTON: "#rp-save-and-refresh"
};

// For elements with dynamic IDs that may change
const DYNAMIC_SELECTORS = {
  MODAL: "div[role=\"dialog\"][aria-modal=\"true\"]",
  IGNORE_BUTTON:
    "div[id^=\"chakra-modal-\"] footer button:first-child, div[role=\"dialog\"][aria-modal=\"true\"] footer button:first-child",
  // Text to identify the specific pricing recommendation modal
  MODAL_TEXT_IDENTIFIER:
    "Set your Minimum Price at least 20% below your Base Price"
};

// Store changes for logging
const changes = [];
const today = new Date().toISOString().split("T")[0];
let dayOfCycle = new Date().getDay(); // 0-6, representing Sunday-Saturday

// Initialize the strategy module
const pricingStrategy = await new PricingStrategy().initialize(config);

// Flag to track if we have UI-based changes not captured by the strategy module
let hasUiOnlyChanges = false;

/**
 * Helper function for waiting - compatible with all Puppeteer versions
 * @param {Object} page - Puppeteer page object
 * @param {number} ms - Milliseconds to wait
 */
async function wait(page, ms) {
  await page.evaluate((timeout) => {
    return new Promise((resolve) => setTimeout(resolve, timeout));
  }, ms);
}

/**
 * Retry function for operations that might fail
 * @param {Function} fn - The function to retry
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} retryDelay - Delay between retries in ms
 */
async function retry(fn, maxRetries = 3, retryDelay = 1000) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      console.log(`Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      lastError = error;
      if (attempt < maxRetries) {
        console.log(`Retrying in ${retryDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  throw lastError;
}

/**
 * Calculate price adjustment based on strategy and current day
 * @param {string} propertyUrl - URL of the property
 * @param {number} currentPrice - The current price value
 * @param {Object} occupancyRates - Current occupancy rates
 * @param {string} priceType - Type of price ("min" or "base")
 * @returns {number} - The adjusted price
 */
function calculatePriceAdjustment(propertyUrl, currentPrice, occupancyRates, priceType) {
  return pricingStrategy.calculateAdjustedPrice(propertyUrl, currentPrice, occupancyRates, priceType);
}

/**
 * Main function to run the PriceLabs bot
 */
async function runBot() {
  console.log("Starting PriceLabs bot...");

  // Launch browser
  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: null,
    args: ["--start-maximized"]
  });

  try {
    const page = await browser.newPage();

    // Set default timeout
    page.setDefaultTimeout(30000);

    // Navigate to login page
    console.log("Navigating to login page...");
    await retry(async () => {
      await page.goto("https://pricelabs.co/signin", {
        waitUntil: "networkidle2"
      });
    });

    // Login
    console.log("Logging in...");
    await retry(async () => {
      await page.type(SELECTORS.EMAIL, process.env.PRICELABS_EMAIL);
      await page.type(SELECTORS.PASSWORD, process.env.PRICELABS_PASSWORD);
      await Promise.all([
        page.click(SELECTORS.SUBMIT),
        page.waitForNavigation({ waitUntil: "networkidle0" })
      ]);
    });

    // Wait for table to load
    console.log("Waiting for property table to load...");
    await retry(async () => {
      await page.waitForSelector(SELECTORS.TABLE_BODY, { visible: true });
    });

    // Extract property links
    console.log("Extracting property links...");
    const propertyLinks = await retry(async () => {
      return await page.evaluate(
        (selector, rowSelector) => {
          const rows = document.querySelectorAll(rowSelector);
          const links = [];

          // Skip the first row (header)
          for (let i = 1; i < rows.length; i++) {
            const link = rows[i].querySelector(selector);
            if (link && link.href) {
              links.push(link.href);
            }
          }

          return links;
        },
        SELECTORS.PROPERTY_LINK,
        SELECTORS.TABLE_ROWS
      );
    });

    console.log(`Found ${propertyLinks.length} properties to process`);

    // Process each property
    for (let i = 0; i < propertyLinks.length; i++) {
      const url = propertyLinks[i];
      console.log(
        `Processing property ${i + 1}/${propertyLinks.length}: ${url}`
      );

      try {
        // Navigate to property page
        await retry(async () => {
          await page.goto(url, { waitUntil: "networkidle0" });
        });

        // Wait for content to load
        await wait(page, 3000); // Using our compatible wait function

        // Record occupancy rates
        let occupancyRates = {};
        try {
          await page.waitForSelector(SELECTORS.OCCUPANCY_RATES, {
            visible: true,
            timeout: 10000,
          });
          occupancyRates = await page.evaluate((selector) => {
            const elements = document.querySelectorAll(selector);

            if (!elements || elements.length === 0) return {};

            // Get text from all occupancy rate elements and convert to decimals
            const occupancyData = {};

            // Helper function to convert percentage string to decimal
            const percentToDecimal = (percentStr) => {
              if (!percentStr || percentStr === "N/A") return null;
              const match = percentStr.match(/(\d+(\.\d+)?)%?/);
              if (!match) return null;
              return parseFloat(match[1]) / 100; // Convert to decimal
            };

            // Check if we have at least one element
            if (elements.length >= 1) {
              occupancyData["7_day_occ"] = elements[0] 
                ? percentToDecimal(elements[0].textContent)
                : null;
              occupancyData["30_day_occ"] = elements[1]
                ? percentToDecimal(elements[1].textContent)
                : null;
              occupancyData["60_day_occ"] = elements[2]
                ? percentToDecimal(elements[2].textContent)
                : null;
            }

            return occupancyData;
          }, SELECTORS.OCCUPANCY_RATES);
        } catch (error) {
          occupancyRates = {
            "7_day_occ": null,
            "30_day_occ": null,
            "60_day_occ": null,
          };
        }

        console.log("Occupancy rates:", {
          "7_day": occupancyRates["7_day_occ"] ? (occupancyRates["7_day_occ"] * 100).toFixed(2) + "%" : "N/A",
          "30_day": occupancyRates["30_day_occ"] ? (occupancyRates["30_day_occ"] * 100).toFixed(2) + "%" : "N/A",
          "60_day": occupancyRates["60_day_occ"] ? (occupancyRates["60_day_occ"] * 100).toFixed(2) + "%" : "N/A"
        });

        // Get and adjust min price
        let minPrice = 0;
        let newMinPrice = 0;

        try {
          await page.waitForSelector(SELECTORS.MIN_PRICE_INPUT, {
            visible: true,
            timeout: 10000
          });

          minPrice = await page.evaluate((selector) => {
            const input = document.querySelector(selector);
            return input ? parseFloat(input.value) : 0;
          }, SELECTORS.MIN_PRICE_INPUT);

          // Calculate new price
          newMinPrice = calculatePriceAdjustment(url, minPrice, occupancyRates, "min");

          // Apply the new price if it's different
          if (newMinPrice !== minPrice) {
            console.log(`Changing min price from ${minPrice} to ${newMinPrice}`);
            
            // More robust approach for setting input values
            try {
              // First try using page.type which simulates actual typing
              await page.click(SELECTORS.MIN_PRICE_INPUT, { clickCount: 3 }); // Select all text
              await page.keyboard.press('Backspace'); // Clear the field
              await page.type(SELECTORS.MIN_PRICE_INPUT, newMinPrice.toString());
              
              // Verify the change was applied
              const actualValue = await page.evaluate((selector) => {
                return document.querySelector(selector).value;
              }, SELECTORS.MIN_PRICE_INPUT);
              
              console.log(`Min price input field now contains: ${actualValue}`);
              
              if (parseFloat(actualValue) !== newMinPrice) {
                console.log(`Warning: Min price field contains ${actualValue} instead of expected ${newMinPrice}`);
                
                // Fallback to JavaScript approach if the type method didn't work
                await page.evaluate(
                  (selector, newValue) => {
                    const input = document.querySelector(selector);
                    if (input) {
                      input.value = "";
                      input.value = newValue;
                      input.dispatchEvent(new Event("input", { bubbles: true }));
                      input.dispatchEvent(new Event("change", { bubbles: true }));
                      input.dispatchEvent(new Event("blur", { bubbles: true }));
                      console.log("Used JS fallback to set min price field");
                    }
                  },
                  SELECTORS.MIN_PRICE_INPUT,
                  newMinPrice
                );
              }
            } catch (inputError) {
              console.error("Error setting min price input:", inputError.message);
              
              // Last resort fallback
              await page.evaluate(
                (selector, newValue) => {
                  const input = document.querySelector(selector);
                  if (input) {
                    input.value = newValue;
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                  }
                },
                SELECTORS.MIN_PRICE_INPUT,
                newMinPrice
              );
            }
          } else {
            console.log(`Min price remains unchanged at ${minPrice}`);
            // Record this as a UI-only change for logging
            hasUiOnlyChanges = true;
          }
        } catch (error) {
          console.log("Could not update min price:", error.message);
        }

        // Get and adjust base price
        let basePrice = 0;
        let newBasePrice = 0;

        try {
          await page.waitForSelector(SELECTORS.BASE_PRICE_INPUT, {
            visible: true,
            timeout: 10000
          });

          basePrice = await page.evaluate((selector) => {
            const input = document.querySelector(selector);
            return input ? parseFloat(input.value) : 0;
          }, SELECTORS.BASE_PRICE_INPUT);

          // Calculate new price
          newBasePrice = calculatePriceAdjustment(url, basePrice, occupancyRates, "base");

          // Apply the new price if it's different
          if (newBasePrice !== basePrice) {
            console.log(`Changing base price from ${basePrice} to ${newBasePrice}`);
            
            // More robust approach for setting input values
            try {
              // First try using page.type which simulates actual typing
              await page.click(SELECTORS.BASE_PRICE_INPUT, { clickCount: 3 }); // Select all text
              await page.keyboard.press('Backspace'); // Clear the field
              await page.type(SELECTORS.BASE_PRICE_INPUT, newBasePrice.toString());
              
              // Verify the change was applied
              const actualValue = await page.evaluate((selector) => {
                return document.querySelector(selector).value;
              }, SELECTORS.BASE_PRICE_INPUT);
              
              console.log(`Base price input field now contains: ${actualValue}`);
              
              if (parseFloat(actualValue) !== newBasePrice) {
                console.log(`Warning: Base price field contains ${actualValue} instead of expected ${newBasePrice}`);
                
                // Fallback to JavaScript approach if the type method didn't work
                await page.evaluate(
                  (selector, newValue) => {
                    const input = document.querySelector(selector);
                    if (input) {
                      input.value = "";
                      input.value = newValue;
                      input.dispatchEvent(new Event("input", { bubbles: true }));
                      input.dispatchEvent(new Event("change", { bubbles: true }));
                      input.dispatchEvent(new Event("blur", { bubbles: true }));
                      console.log("Used JS fallback to set base price field");
                    }
                  },
                  SELECTORS.BASE_PRICE_INPUT,
                  newBasePrice
                );
              }
            } catch (inputError) {
              console.error("Error setting base price input:", inputError.message);
              
              // Last resort fallback
              await page.evaluate(
                (selector, newValue) => {
                  const input = document.querySelector(selector);
                  if (input) {
                    input.value = newValue;
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                  }
                },
                SELECTORS.BASE_PRICE_INPUT,
                newBasePrice
              );
            }
          } else {
            console.log(`Base price remains unchanged at ${basePrice}`);
            // Record this as a UI-only change for logging
            hasUiOnlyChanges = true;
          }
        } catch (error) {
          console.log("Could not update base price:", error.message);
        }

        await page.waitForSelector(SELECTORS.SAVE_BUTTON, {
          visible: true,
          timeout: 10000
        });
        await Promise.all([
          page.click(SELECTORS.SAVE_BUTTON)
        ]);
        await wait(page, 2000);


        const buttons = await page.$$("button");

        if (buttons.length > 0) {


          // Loop through buttons and get their text content
          for (const button of buttons) {
            const text = await button.evaluate((el) => el.textContent.trim());

            // Optionally click or do something with each button
            // await button.click();
            if (text === "Ignore Recommendation") {
              console.log("Modal found, ignoring recommendation");
              await button.click();
              await wait(page, 10000);
            }

          }

          
        } else {
          console.log("No buttons found on the page.");
        }

        if (buttons.length > 0) {


          // Loop through buttons and get their text content
          for (const button of buttons) {
            const text = await button.evaluate((el) => el.textContent.trim());

            // Optionally click or do something with each button
            // await button.click();
            if (text === "Sync Now") {
              console.log("Sync button found, clicking");
              await button.click();
              await wait(page, 10000);
            }

          }

          
        } else {
          console.log("No buttons found on the page.");
        }



        

        // Record the change
        changes.push({
          url,
          date: today,
          occupancy: occupancyRates,
          minPrice: {
            before: minPrice,
            after: newMinPrice
          },
          basePrice: {
            before: basePrice,
            after: newBasePrice
          }
        });

        // Only if we've made actual changes, attempt to save them
        if (minPrice !== newMinPrice || basePrice !== newBasePrice) {
          try {
            await page.waitForSelector(SELECTORS.SAVE_BUTTON, {
              visible: true,
              timeout: 10000
            });
            await Promise.all([
              page.click(SELECTORS.SAVE_BUTTON)
            ]);
            await wait(page, 2000);
          } catch (error) {
            console.error("Failed to save changes:", error.message);
          }
        }
      } catch (error) {
        console.error(`Error processing property ${url}:`, error.message);
        // Add to changes log even if there was an error
        changes.push({
          url,
          date: today,
          error: error.message
        });
      }

      // Brief pause between properties
      await wait(page, 2000); // Using our compatible wait function
    }

    // Near the end where we save the changes to file:

    /**
     * Save changes to log file, preserving history
     * @param {string} logFile - Path to the log file
     * @param {Array} newChanges - New changes to append
     */
    async function saveChangesToLog(logFile, newChanges) {
      let existingData = { lastRun: today, changes: [] };
      
      try {
        // Check if log file exists
        try {
          await fs.access(logFile);
          // File exists, read it
          const fileContent = await fs.readFile(logFile, 'utf8');
          existingData = JSON.parse(fileContent);
        } catch (err) {
          // File doesn't exist or can't be read, we'll create a new one
          console.log(`No existing log file found at ${logFile}, creating new file`);
        }
        
        // Update the lastRun date
        existingData.lastRun = today;
        
        // Append new changes to existing changes
        if (!Array.isArray(existingData.changes)) {
          existingData.changes = [];
        }
        
        // Add new changes to the beginning of the array (most recent first)
        existingData.changes = [...newChanges, ...existingData.changes];
        
        // Optionally, limit the size of the history to prevent the file from growing too large
        const maxHistoryEntries = 1000; // Adjust as needed
        if (existingData.changes.length > maxHistoryEntries) {
          existingData.changes = existingData.changes.slice(0, maxHistoryEntries);
          console.log(`Trimmed change history to ${maxHistoryEntries} entries`);
        }
        
        // Write updated data back to file
        await fs.writeFile(
          logFile,
          JSON.stringify(existingData, null, 2),
          'utf8'
        );
        
        console.log(`Added ${newChanges.length} new entries to change history in ${logFile}`);
        console.log(`Total entries in history: ${existingData.changes.length}`);
        
      } catch (error) {
        console.error('Error saving changes to log:', error);
        
        // Still try to save to a backup file if main save fails
        try {
          await fs.writeFile(
            `${logFile}.backup-${today}`,
            JSON.stringify({ lastRun: today, changes: newChanges }, null, 2),
            'utf8'
          );
          console.log(`Saved backup of new changes to ${logFile}.backup-${today}`);
        } catch (backupError) {
          console.error('Failed to save backup file:', backupError);
        }
      }
      
      return existingData;
    }

    // Replace the original log-saving code with this:
    try {
      // First, let the strategy module save its changes
      await pricingStrategy.saveChanges();
      
      // Then save our UI-based changes separately if either:
      // 1. We have UI-specific changes, or
      // 2. The file doesn't exist yet (to ensure we create it)
      const fileExists = await fileExistsAsync(config.logFile);
      
      if ((hasUiOnlyChanges && changes.length > 0) || !fileExists) {
        await saveChangesToLog(config.logFile, changes);
        console.log(`${fileExists ? 'Additional UI-based changes' : 'Initial changes'} saved to ${config.logFile}`);
      }
      
      console.log(`Processing complete. Results saved to ${config.logFile}`);
    } catch (error) {
      console.error('Bot encountered an error when saving logs:', error);
    }

    // Add this helper function to check if a file exists
    async function fileExistsAsync(filePath) {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }
  } catch (error) {
    console.error("Bot encountered an error:", error);

    // Still try to save any changes that were recorded
    if (changes.length > 0) {
      try {
        await fs.writeFile(
          `${config.logFile}.partial`,
          JSON.stringify({ lastRun: today, changes }, null, 2),
          "utf8"
        );
        console.log(`Partial results saved to ${config.logFile}.partial`);
      } catch (saveError) {
        console.error("Failed to save partial results:", saveError);
      }
    }
  } finally {
    await browser.close();
    console.log("Browser closed. Bot execution finished.");
  }
}

// Run the bot
runBot().catch(console.error);
