# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Israeli bank scraper REST API server that wraps the `israeli-bank-scrapers` library. Designed to run on Railway via Docker with headless Chromium.

## Commands

```bash
npm start          # Start the server (port 3000 or $PORT)
docker build -t bank-scraper .  # Build Docker image
```

No tests or lint scripts are configured.

## Architecture

**Single-file Express server** (`server.js`) with three main parts:

1. **COMPANY_CONFIG** (lines 13-115): Configuration object mapping company keys to their:
   - `companyId`: From `israeli-bank-scrapers` CompanyTypes enum
   - `fields`: Required credential fields for that company
   - `mapCredentials`: Function to transform request body to scraper format

2. **API Endpoints**:
   - `GET /` and `/health` - Health checks
   - `GET /api/companies` - List supported companies with required fields
   - `POST /api/scrape/:company` - Generic scrape endpoint (body: credentials + optional startDate)
   - `POST /api/scrape-discount` - Legacy endpoint (maps `userCode` to `num`)

3. **Scraper Flow** (lines 169-270):
   - Launch Puppeteer browser with system Chromium
   - Create scraper with `combineInstallments: false` (important for installment tracking)
   - Return flattened transactions array with all account data

## Supported Companies

Banks: hapoalim, leumi, discount, mizrahi, mercantile, otsarHahayal, union, beinleumi, massad, yahav

Credit Cards: visaCal, max, isracard, amex

Other: beyahadBishvilha, behatsdaa

## Deployment

- Uses system Chromium at `/usr/bin/chromium` (set via `PUPPETEER_EXECUTABLE_PATH`)
- `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` in Docker to use system browser
- Dockerfile installs all required Chromium dependencies for headless operation
