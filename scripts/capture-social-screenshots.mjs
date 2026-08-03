import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

async function captureScreenshots() {
  const outputDir = path.resolve(process.cwd(), 'social-screenshots');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // Retina scaling for crisp resolution
  });

  const page = await context.newPage();

  console.log('[Screenshots] Navigating to http://localhost:3000...');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // 1. Verify "Live API" header
  const headerText = await page.locator('header').first().innerText();
  console.log('[Screenshots] Header Text:', headerText);

  if (headerText.includes('Offline')) {
    console.error('ERROR: App is displaying "Offline · mock data"!');
    await browser.close();
    process.exit(1);
  }

  console.log('✅ Live API verified!');

  // Capture Screenshot 1: Main Dashboard
  const dashPath = path.join(outputDir, '01-dashboard.png');
  await page.screenshot({ path: dashPath, fullPage: false });
  console.log('[Screenshots] Saved:', dashPath);

  // Open Integrations Modal
  console.log('[Screenshots] Opening Integrations modal...');
  // Click Integrations button in nav bar or card
  const integrationsBtn = page.locator('button:has-text("Connected Integrations"), button:has-text("Integrations"), nav button:has-text("Integrations")').first();
  if (await integrationsBtn.isVisible()) {
    await integrationsBtn.click();
  } else {
    // Try clicking sidebar or nav item
    await page.locator('text=Integrations').first().click();
  }
  await page.waitForTimeout(800);

  // Capture Screenshot 2: Integrations Modal
  const intPath = path.join(outputDir, '02-integrations-modal.png');
  await page.screenshot({ path: intPath, fullPage: false });
  console.log('[Screenshots] Saved:', intPath);

  // Close Integrations Modal
  const closeBtn = page.locator('button[aria-label="Close"]').first();
  if (await closeBtn.isVisible()) {
    await closeBtn.click();
    await page.waitForTimeout(500);
  }

  // Open SOP Inspector
  console.log('[Screenshots] Opening SOP Inspector modal...');
  const inspectBtn = page.locator('button:has-text("Inspect Steps")').first();
  if (await inspectBtn.isVisible()) {
    await inspectBtn.click();
    await page.waitForTimeout(800);

    // Capture Screenshot 3: SOP Inspector
    const inspectorPath = path.join(outputDir, '03-sop-inspector.png');
    await page.screenshot({ path: inspectorPath, fullPage: false });
    console.log('[Screenshots] Saved:', inspectorPath);
  }

  await browser.close();
  console.log('✅ All social screenshots captured successfully!');
}

captureScreenshots().catch((err) => {
  console.error('Screenshot script error:', err);
  process.exit(1);
});
