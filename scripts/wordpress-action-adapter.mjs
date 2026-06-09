#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const configPath = readArg("--config");
const payloadText = readArg("--payload");

if (!configPath) fail("Missing --config", 2);
if (!payloadText) fail("Missing --payload", 2);
if (!fs.existsSync(configPath)) fail(`WordPress config not found: ${configPath}`, 2);

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const payload = JSON.parse(payloadText);
const action = payload.action || {};

const response = {
  adapter: "wordpress-action-adapter",
  site_id: config.site_id,
  site_url: config.site_url,
  live: Boolean(payload.live),
  action_id: action.id || null,
  action_type: action.action_type || null,
  platform: action.platform || null,
  status: "dry_run_ready",
  message: "WordPress action payload validated. No live site changes were made.",
  capabilities: [
    "wp_session_check",
    "cf7_inventory",
    "cf7_mail_settings_dry_run",
    "public_form_submit_test",
    "wordpress_page_update_draft"
  ],
  next_live_step: "Implement Playwright-backed WordPress session control for the specific approved action type."
};

if (payload.live) {
  response.status = "blocked_live_driver";
  response.message = "Live WordPress browser execution is intentionally blocked until a Playwright session driver is implemented and authenticated.";
  console.log(JSON.stringify(response, null, 2));
  process.exit(3);
}

console.log(JSON.stringify(response, null, 2));
