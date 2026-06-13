# Grizzly WordPress Contact Form Handoff - 2026-06-08

## Access

- Site: https://www.grizzlyelectricaltx.com/
- WordPress login: https://www.grizzlyelectricaltx.com/wp-login.php
- Admin dashboard: https://www.grizzlyelectricaltx.com/wp-admin/
- Credentials are not stored in this repo. Use the authenticated browser/session or owner-provided credentials.
- Current WordPress administration email shown during login verification: sfsadmin@surefirelocal.com

## Plugins And Areas

- Contact forms are managed by Contact Form 7.
- Redirect behavior is managed by the CF7 Redirection add-on.
- Admin path: WordPress Dashboard -> Contact -> Contact Forms.
- Contact Form 7 version observed on public forms: 6.1.6.

## Active Forms

- Contact Us
  - Admin post ID: 626
  - Shortcode: `[contact-form-7 id="ddf899f" title="Contact Us"]`
  - Public page: https://www.grizzlyelectricaltx.com/contact-us/
  - Rendered unit tag: `wpcf7-f626-p194-o1`
  - Fields: `fname`, `email`, `phone`, `message`, `acceptance`, `lead_source`
  - Success redirect observed: https://www.grizzlyelectricaltx.com/contact-us-thank-you/

- Inquire
  - Admin post ID: 40
  - Shortcode: `[contact-form-7 id="1d8e49f" title="Inquire"]`
  - Public locations: homepage and secondary/footer form on contact page
  - Homepage rendered unit tag: `wpcf7-f40-o1`
  - Contact-page rendered unit tag: `wpcf7-f40-o2`
  - Fields: `fname`, `phone`, `email`, `message`, `acceptance`, `lead_source`

## Mail Configuration Applied

Both forms previously had two Contact Form 7 configuration errors because their From address used `noreply@formleads.surepulse.com`, which does not belong to the site domain.

Updated both forms:

- To: `contactus@grizzlyelectrical.net`
- From: `[_site_title] <wordpress@grizzlyelectricaltx.com>`
- Primary mail Reply-To: `[fname] <[email]>`
- Mail 2/autoresponder From: `[_site_title] <wordpress@grizzlyelectricaltx.com>`
- Mail 2/autoresponder Reply-To: `Grizzly Electrical Solutions <contactus@grizzlyelectrical.net>`

After saving, the Contact Forms list no longer showed the `2 configuration errors detected` warning for either form.

## Verification

- Public contact URL checked: https://www.grizzlyelectricaltx.com/contact-us/
- Public `/contact/` URL returns 404.
- A live test submission was sent through the primary Contact Us form using the message:
  `Automated SEO agent verification test after fixing Contact Form 7 mail settings. Please ignore.`
- The form redirected successfully to `/contact-us-thank-you/`.
- Owner confirmed on 2026-06-09 that the test lead arrived in the mailbox.

## Follow-Up For Website Action Agent

- Confirm the autoresponder arrives at the submitted email address.
- If delivery is unreliable, check SMTP/SPF/DKIM for `grizzlyelectricaltx.com` and consider installing/configuring a WordPress SMTP plugin.
- Keep future form changes scoped to CF7 fields, mail headers, redirect action, and page shortcode placement.
- Do not store WordPress credentials in repo files.
