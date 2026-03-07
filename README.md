# Water Bills Auto Uploader (Chrome Extension)

This extension automates your page flow:
1. Select CSV/Excel file(s)
2. It fills the "Drop your file here" upload input
3. It clicks the **Upload File** button
4. Repeats on a scheduler (seconds / minutes / hours)
5. Tracks total upload count
6. Shows next-upload countdown in the popup

## Install (Developer Mode)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   - `C:\Users\Rising\Downloads\upload bills`

## Use

1. Open your target page:
   - `https://w-001-admin.vercel.app/dashboard/upload`
2. Click the extension icon.
3. Choose files from your `WaterBills` folder using:
   - **Select Excel/CSV files**, or
   - **Or select folder**
4. Set interval value and unit (seconds/minutes/hours).
5. Click **Start**.

It will do an immediate upload and then continue on the chosen interval.

### Close Behavior

- **Stop when popup closes**: closes popup and stops automation.
- **Keep running in background**: closes popup and continues automation.

## Notes

- Browser security does not allow auto-reading `C:\Users\Rising\Downloads\WaterBills` without user selection. So select file/folder once in the popup.
- If multiple files are selected, the extension uploads them in sequence and loops.
- Upload count is saved in extension storage.

## Files

- `manifest.json` - Extension configuration (MV3)
- `popup.html`, `popup.css`, `popup.js` - UI and scheduler controls
- `content.js` - Page automation logic
