#!/usr/bin/env node
/**
 * gbp-post-once.mjs
 * One-shot GBP post using the existing Playwright browser session.
 * Does not use the workbook — content is passed directly.
 * Usage: node gbp-post-once.mjs [--dry-run]
 */
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const USER_DATA_DIR = path.join(os.homedir(), '.claude', 'gbp-session');
const VIEWPORT = { width: 1365, height: 900 };

const POST = {
  caption: `If something in your home is not working right, guessing usually does not save time. We help DFW homeowners track down electrical problems like flickering lights, tripping breakers, dead outlets, and switches that are acting up. Clear diagnosis, practical recommendations, and clean work.\n\nCall for troubleshooting service.`,
  imagePath: 'C:\\Workspace\\Shared\\Assets\\Media\\Grizzly\\GBP Post Photos\\2026-05-03-breaker-panel-inspection-labeling-and-recommendation-for-cleaning-or-panel-upgra-84b4e50d53.jpg',
};

const dryRun = process.argv.includes('--dry-run');

if (dryRun) {
  console.log('DRY RUN — would post:');
  console.log('Caption:', POST.caption.slice(0, 100) + '...');
  console.log('Image:', POST.imagePath);
  console.log('Image exists:', fs.existsSync(POST.imagePath));
  process.exit(0);
}

if (!fs.existsSync(POST.imagePath)) {
  console.error('Image not found:', POST.imagePath);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  viewport: VIEWPORT,
});

const page = await context.newPage();

try {
  await page.goto('https://business.google.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // Check not redirected to login
  if (/accounts\.google\.com/.test(page.url())) {
    throw new Error('GBP session expired — need to re-auth: node driver.mjs --auth');
  }

  // Open post composer
  const directAdd = page.locator('button:has-text("Add update")').first();
  const postsBtn = page.locator('button:has-text("Posts"), text="Posts"').first();
  await directAdd.or(postsBtn).first().waitFor({ timeout: 20000 });

  if (await directAdd.count()) {
    await directAdd.scrollIntoViewIfNeeded();
    await directAdd.click();
  } else {
    await postsBtn.click();
    const addPost = page.locator('button:has-text("Add post"), div[role="button"]:has-text("Add a post"), button:has-text("Add update")').first();
    await addPost.waitFor({ timeout: 15000 });
    await addPost.click();
  }

  // Fill caption
  const input = page.locator('div[role="dialog"] [contenteditable="true"], div[role="dialog"] textarea, [contenteditable="true"], textarea').first();
  await input.waitFor({ timeout: 20000 });
  await input.click();
  await input.fill(POST.caption);

  // Attach image
  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count()) {
    await fileInput.setInputFiles(POST.imagePath, { timeout: 15000 });
  } else {
    const selectText = page.getByText('Select images and videos', { exact: true }).first();
    await selectText.waitFor({ timeout: 15000 });
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 15000 });
    await selectText.click();
    const chooser = await chooserPromise;
    await chooser.setFiles(POST.imagePath);
  }

  // Wait for image upload
  await page.waitForTimeout(3000);

  // Click Post / Publish
  const postBtn = page.locator('button:has-text("Post"), button:has-text("Publish"), div[role="button"]:has-text("Post")').first();
  await postBtn.waitFor({ timeout: 20000 });
  await postBtn.click();

  // Wait for composer to close (indicates success)
  await input.waitFor({ state: 'hidden', timeout: 30000 });

  const errorBanner = page.locator('text=/something went wrong|couldn\'t be posted|could not be posted|try again/i').first();
  if (await errorBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
    throw new Error('GBP showed an error after submitting: ' + await errorBanner.innerText().catch(() => ''));
  }

  console.log(JSON.stringify({ result: 'posted', verified: true }));

} catch (err) {
  // Save screenshot on failure
  const outDir = 'C:\\Workspace\\Active\\SEO-Agents-App\\outputs\\gbp-debug';
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await page.screenshot({ path: path.join(outDir, `failure-${stamp}.png`), fullPage: true }).catch(() => {});
  console.error('GBP post failed:', err.message);
  process.exit(1);
} finally {
  await context.close();
}
