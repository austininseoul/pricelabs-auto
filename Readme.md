# PriceLabs Bot

A Puppeteer automation bot for managing PriceLabs property pricing adjustments.

## Features

- Automatically logs into PriceLabs account
- Extracts all property links from the dashboard
- For each property:
  - Records occupancy rates (7-day, 30-day, 60-day)
  - Adjusts minimum and base prices according to the configured strategy
  - Handles confirmation modals
  - Saves changes
- Logs all changes to a JSON file for record keeping

## Prerequisites

- [Bun](https://bun.sh/) installed
- Node.js environment (v16 or higher recommended)
- PriceLabs account credentials

## Setup

1. Clone the repository
2. Install dependencies:
   ```
   bun install
   ```
3. Configure your environment variables in the `.env` file:
   ```
   PRICELABS_EMAIL="your-email@example.com"
   PRICELABS_PASSWORD="your-password"
   ```

## Configuration

Edit the `config.json` file to adjust pricing strategies:

```json
{
  "strategy": "hold", 
  "adjustments": {
    "increase": {
      "percentage": 2,
      "duration": 7
    },
    "decrease": {
      "percentage": 2,
      "duration": 7
    },
    "hold": {
      "oscillationPercentage": 1
    }
  },
  "logFile": "pricelabs_changes.json"
}
```

Available strategies:
- `increase`: Increases prices by the specified percentage
- `decrease`: Decreases prices by the specified percentage
- `hold`: Oscillates prices slightly up and down to maintain an average price

## Usage

Run the bot with:

```
bun start
```

The bot will:
1. Launch a browser
2. Log in to PriceLabs
3. Extract property links
4. Process each property according to the strategy
5. Log all changes to the specified JSON file

## Caution

- This bot interacts with a live production system. Test with caution.
- The bot runs with `headless: false` by default so you can observe its actions. Change to `true` for production use.
- Check the logs and results before making large-scale changes.

## Logs

Changes are logged to the file specified in `config.json` (default: `pricelabs_changes.json`) in the following format:

```json
{
  "lastRun": "2023-03-02",
  "changes": [
    {
      "url": "https://pricelabs.co/property/123",
      "date": "2023-03-02",
      "occupancy": {
        "7_day_occ": "30%",
        "30_day_occ": "45%",
        "60_day_occ": "60%"
      },
      "minPrice": {
        "before": 100,
        "after": 102
      },
      "basePrice": {
        "before": 120,
        "after": 122
      }
    }
  ]
}
```

