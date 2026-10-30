# QR Shield – QR Code Malicious Link Detection and Safety Verification

A static web app that decodes QR codes in the browser, identifies what they contain, and runs local URL checks. Built with HTML5, CSS3, vanilla JavaScript, the Canvas API, the URL API and [jsQR](https://github.com/cozmo/jsQR) (loaded from the jsDelivr CDN).

## Features
- Upload QR images (PNG, JPG, JPEG) or scan with the camera; several QR codes in one image are supported.
- Classifies URLs, Wi-Fi, UPI, phone, email, SMS, vCard, geo, plain text and unknown data. Nothing is ever opened or executed automatically. Wi-Fi passwords are masked.
- Local URL analysis: length, IP hosts, subdomains, brand impersonation, punycode and encoding, embedded credentials, http vs https, dangerous schemes, shorteners.
- Outcomes: LOW RISK, MEDIUM RISK, HIGH RISK, UNVERIFIED.
- Safety report with copy, download (.txt) and scan-another actions. History and counters are kept in the browser's localStorage.

## Honest limits
Local rules are heuristics. They cannot prove a site is safe or malicious, and LOW RISK only means no warning patterns were found. Every report says "Not verified" until a threat-intelligence backend is connected. No API results are simulated.

## Deploy on GitHub Pages
1. Create a GitHub repository (for example `qr-shield`) and upload the contents of this folder so `index.html` is at the repository root.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, choose the `main` branch and the `/ (root)` folder, then **Save**.
4. After a minute your site is live at `https://<username>.github.io/<repository>/`. GitHub Pages serves HTTPS, which the camera requires.

To test locally, run `python -m http.server` in this folder and open `http://localhost:8000` (localhost allows the camera).

## Future: Google Safe Browsing
Never put an API key in `script.js`. Build a small backend (for example a serverless function) that stores the key, accepts `POST {url}`, calls the Safe Browsing Lookup API and returns `{ "verdict": "SAFE" | "UNSAFE" | "UNKNOWN" }`. Then set `ThreatIntel.endpoint` in `script.js` to that backend URL (and allow your Pages origin via CORS). The `ThreatIntel.check()` function and report wiring already exist.

## Structure
```
qr-shield/
├── index.html
├── style.css
├── script.js
├── README.md
└── assets/logo.svg
```
