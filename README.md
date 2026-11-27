# Sleep Tracker

A standalone copy of my Sleep Tracker dashboard. It reads my Sleep log Google Sheet live, through the sheet's "Publish to web" CSV link, so it updates whenever I add a night.

- `index.html`: the page and its styles
- `app.js`: the calculations and charts
- `runtime.js`: loads the sheet and redraws the page
- `config.js`: the sheet link and how often the page checks it for new data
- `d3.min.js`: the D3 charting library (ISC licence, see `D3-LICENSE.txt`)

To point it at a different sheet, replace `csvUrl` in `config.js` with that sheet's published CSV link.
