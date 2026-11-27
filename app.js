// Sleep Tracker: calculations and drawings (same as the Claude version).
(() => {
  // Reference the person can change: hours of sleep a night to aim for.
  const GOAL_MIN = 7 * 60;
  // Targets the person set, in percent: blue at or above, orange below.
  const TARGET_EFFICIENCY = 90;
  const TARGET_HABITS = 80;

  const RANGE_LABELS = {'7': 'last 7 days', '14': 'last 14 days', '30': 'last 30 days', '90': 'last 90 days', all: 'all nights'};
  const fmtDayShort = d3.utcFormat('%b %-d');
  const fmtDayYear = d3.utcFormat('%b %-d, %Y');
  const fmtDayLong = d3.utcFormat('%a, %b %-d');
  const fmtDayAxis = d3.utcFormat('%a %b %-d');
  const parseDay = (s) => (s ? new Date(`${s}T00:00:00Z`) : null);
  const clockLabel = (t) => {
    if (t == null || !isFinite(t)) return '';
    const r = ((Math.round(t) % 1440) + 1440) % 1440;
    const h = Math.floor(r / 60);
    return `${h % 12 || 12}${r % 60 ? `:${String(r % 60).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
  };
  // Claude palette, defined in the page's CSS so it follows light and dark themes.
  const COLOR = {sleep: 'var(--ht-orange)', met: 'var(--ht-blue)', awake: 'var(--ht-awake)', ink: 'var(--color-fg)', zone: 'var(--ht-tint-blue)', stripe: 'var(--ht-stripe)'};

  // ---------- Sheet → rows ----------
  dash.loader('sleep_log', {
    description: 'Turns the sheet’s grid into one row per morning, naming each column from its header and skipping blank rows.',
    fn: ({answer}) => {
      let a = answer;
      if (typeof a === 'string') {
        try { a = JSON.parse(a); } catch (e) { throw new Error(a.slice(0, 300)); }
      }
      if (a && a.content && !a.values) a = a.content;
      if (a && a.error) throw new Error(typeof a.error === 'string' ? a.error : (a.error.message || 'Google Sheets returned an error.'));
      const grid = (a && a.values) || [];
      if (!grid.length) return {columns: [], rows: []};
      const names = [
        [/date/i, 'date'], [/into bed/i, 'bed'], [/asleep/i, 'asleep'],
        [/screens? before/i, 'no_screens_before'], [/screens? after/i, 'no_screens_after'],
        [/sun/i, 'sunlight'], [/made.*bed|make.*bed/i, 'made_bed'], [/out of bed/i, 'up'],
        [/waking/i, 'wakings'], [/woke|wake/i, 'woke'],
        [/^\s*notes?\b/i, 'notes'],
      ];
      const used = new Set();
      const columns = grid[0].map((h, i) => {
        const text = String(h ?? '').trim();
        const hit = names.find(([re, key]) => re.test(text) && !used.has(key));
        let key = hit ? hit[1] : (text || `column_${i + 1}`);
        if (used.has(key)) key = `${key}_${i + 1}`;
        used.add(key);
        return key;
      });
      const cell = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
      const rows = grid.slice(1)
        .filter((r) => r.some((v) => cell(v) != null))
        .map((r) => Object.fromEntries(columns.map((c, i) => [c, cell(r[i])])));
      return {columns, rows};
    },
  });

  // ---------- Worked-out nights ----------
  dash.calc('nights', {
    title: 'Nights, worked out',
    description: 'Each logged morning with its times on one clock, time asleep, time in bed, efficiency and habits kept.',
    inputs: ['sleep_log'],
    fn: (sleepLog) => {
      // "12:40 AM", "7am" or "00:40" → minutes after midnight
      const clock = (s) => {
        const t = String(s ?? '').trim().toLowerCase().replace(/\./g, '');
        let m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)$/);
        if (m) return ((+m[1] % 12) + (m[3][0] === 'p' ? 12 : 0)) * 60 + +(m[2] || 0);
        m = t.match(/^(\d{1,2}):(\d{2})$/);
        return m && +m[1] < 24 ? +m[1] * 60 + +m[2] : null;
      };
      // One clock per night, counted from the midnight before the evening:
      // bedtimes after midnight and all wake times move to the next day.
      const evening = (t) => (t == null ? null : t < 12 * 60 ? t + 1440 : t);
      const morning = (t) => (t == null ? null : t < 18 * 60 ? t + 1440 : t);
      const span = (a, b) => (a != null && b != null && b >= a ? b - a : null);
      const hm = (m) => {
        if (m == null || !isFinite(m)) return null;
        const r = Math.round(m);
        return `${Math.floor(r / 60)}h ${String(r % 60).padStart(2, '0')}m`;
      };
      const clk = (t) => {
        if (t == null) return null;
        const r = ((Math.round(t) % 1440) + 1440) % 1440;
        const h = Math.floor(r / 60);
        return `${h % 12 || 12}:${String(r % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
      };
      // "Mon Nov 23", "Nov 23, 2026", "11/23/2026" or "2026-11-23" → "2026-11-23".
      // With no year: this year or last (never a future date), the one whose weekday matches.
      const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const now = new Date();
      const latest = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 2);
      const iso = (y, mo, d) => {
        const x = new Date(Date.UTC(y, mo, d));
        return x.getUTCMonth() === mo && x.getUTCDate() === d ? x.toISOString().slice(0, 10) : null;
      };
      const toDay = (s) => {
        const t = String(s ?? '').trim();
        let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return iso(+m[1], +m[2] - 1, +m[3]);
        let y = null, mo = null, d = null;
        m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
        if (m) {
          mo = +m[1] - 1; d = +m[2];
          y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
        } else {
          for (const x of t.matchAll(/([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/gi)) {
            const i = MONTHS.indexOf(x[1].slice(0, 3).toLowerCase());
            if (i >= 0) { mo = i; d = +x[2]; y = x[3] ? +x[3] : null; break; }
          }
        }
        if (mo == null) return null;
        if (y != null) return iso(y, mo, d);
        const wd = DAYS.indexOf(t.slice(0, 3).toLowerCase());
        const years = [0, 1, 2].map((k) => now.getFullYear() - k).filter((yy) => Date.UTC(yy, mo, d) <= latest).slice(0, 2);
        const match = years.find((yy) => wd < 0 || new Date(Date.UTC(yy, mo, d)).getUTCDay() === wd);
        return iso(match ?? years[0] ?? now.getFullYear(), mo, d);
      };
      const yes = (v) => {
        const t = String(v ?? '').trim().toLowerCase();
        if (!t || /^n\/?a$/.test(t)) return null;
        if (/^(y|yes|true|done|✓|✔)/.test(t)) return true;
        if (/^(n|no|false|✗|✘)/.test(t)) return false;
        return null;
      };
      const habitKeys = ['sunlight', 'no_screens_before', 'no_screens_after', 'made_bed'];

      const rows = sleepLog.map((r) => {
        const bed_t = evening(clock(r.bed));
        const asleep_t = evening(clock(r.asleep));
        const woke_t = morning(clock(r.woke));
        const up_t = morning(clock(r.up));
        const sleep_min = span(asleep_t, woke_t);
        const in_bed_min = span(bed_t, up_t);
        const habits = Object.fromEntries(habitKeys.map((k) => [k, yes(r[k])]));
        const logged = habitKeys.filter((k) => habits[k] != null).length;
        const done = habitKeys.filter((k) => habits[k] === true).length;
        const wakingsText = String(r.wakings ?? '').trim();
        const count = wakingsText.match(/\d+/);
        return {
          date: r.date,
          day: toDay(r.date),
          bed_clock: clk(bed_t), asleep_clock: clk(asleep_t), woke_clock: clk(woke_t), up_clock: clk(up_t),
          bed_t, asleep_t, woke_t, up_t,
          sleep_min, sleep_hm: hm(sleep_min),
          in_bed_min, in_bed_hm: hm(in_bed_min),
          latency_min: span(bed_t, asleep_t),
          lie_in_min: span(woke_t, up_t),
          efficiency_pct: sleep_min != null && in_bed_min ? Math.min(100, Math.round((100 * sleep_min) / in_bed_min)) : null,
          wakings: count ? +count[0] : /^(none|no)$/i.test(wakingsText) ? 0 : null,
          wakings_note: wakingsText.replace(/^\d+\s*[,;:\-–—]?\s*/, '').replace(/^\((.*)\)$/, '$1') || null,
          notes: r.notes ?? null,
          ...habits,
          habits_done: done,
          habits_logged: logged,
          habits_label: logged ? `${done} of ${logged}` : null,
        };
      });
      rows.sort((a, b) => (a.day ?? '9999').localeCompare(b.day ?? '9999'));
      // Average hours asleep over the 7 days ending each night, once 3 or more of those nights have a time.
      const dated = rows.filter((r) => r.day);
      for (const r of dated) {
        const end = Date.parse(r.day);
        const week = dated.filter((o) => o.sleep_min != null && Date.parse(o.day) <= end && Date.parse(o.day) > end - 7 * 864e5);
        r.avg7_min = week.length >= 3 ? Math.round(week.reduce((s, o) => s + o.sleep_min, 0) / week.length) : null;
      }
      return rows;
    },
  });

  dash.calc('shown_nights', {
    title: 'Nights in the chosen range',
    description: 'The nights inside the range picked at the top, counted back from the latest night in the sheet.',
    inputs: ['nights'],
    fn: (nights) => {
      const range = dash.params().range ?? '30';
      const dated = nights.filter((n) => n.day);
      const days = Number(range);
      if (range === 'all' || !(days > 0) || !dated.length) return dated;
      const from = Date.parse(dated[dated.length - 1].day) - (days - 1) * 864e5;
      return dated.filter((n) => Date.parse(n.day) >= from);
    },
  });

  dash.calc('summary', {
    title: 'Sleep summary',
    description: 'Averages and counts over the nights in the chosen range, and the gap to the hours-a-night guideline.',
    inputs: ['shown_nights', 'nights'],
    fn: (shown, nights) => {
      const goalMin = GOAL_MIN;
      const vals = (k, list = shown) => list.map((n) => n[k]).filter((v) => v != null && isFinite(v));
      const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
      const round = (v) => (v == null ? null : Math.round(v));
      const hm = (m) => {
        if (m == null) return null;
        const r = Math.round(m);
        return `${Math.floor(r / 60)}h ${String(r % 60).padStart(2, '0')}m`;
      };
      const short = (m) => (m < 60 ? `${m} min` : hm(m));
      const clk = (t) => {
        if (t == null) return null;
        const r = ((Math.round(t) % 1440) + 1440) % 1440;
        const h = Math.floor(r / 60);
        return `${h % 12 || 12}:${String(r % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
      };
      const sleeps = vals('sleep_min');
      const avgSleep = mean(sleeps);
      const gap = round(avgSleep == null ? null : avgSleep - goalMin);
      const starts = vals('asleep_t');
      const startMean = mean(starts);
      const startSd = starts.length > 1 ? Math.sqrt(mean(starts.map((v) => (v - startMean) ** 2))) : null;
      const both = shown.filter((n) => n.sleep_min != null && n.in_bed_min);
      const sumSleep = both.reduce((s, n) => s + n.sleep_min, 0);
      const sumBed = both.reduce((s, n) => s + n.in_bed_min, 0);
      const habitsDone = shown.reduce((s, n) => s + n.habits_done, 0);
      const habitsLogged = shown.reduce((s, n) => s + n.habits_logged, 0);
      const last = [...shown].reverse().find((n) => n.sleep_min != null) ?? null;
      const earlier = last ? vals('sleep_min', shown.filter((n) => n !== last)) : [];
      const change = last && earlier.length ? Math.round(last.sleep_min - mean(earlier)) : null;
      const wakings = mean(vals('wakings'));
      return [{
        nights_logged: shown.length,
        range_from: shown.length ? shown[0].day : null,
        range_to: shown.length ? shown[shown.length - 1].day : null,
        avg_sleep_min: round(avgSleep),
        avg_sleep_hm: hm(avgSleep),
        goal_min: goalMin,
        goal_gap_min: gap,
        goal_gap_label: gap == null ? null : gap < 0 ? `${short(-gap)} under` : gap > 0 ? `${short(gap)} over` : 'right at',
        nights_goal_met: sleeps.filter((v) => v >= goalMin).length,
        avg_asleep_t: round(startMean),
        avg_asleep_clock: clk(startMean),
        avg_woke_t: round(mean(vals('woke_t'))),
        avg_woke_clock: clk(mean(vals('woke_t'))),
        onset_sd_min: round(startSd),
        efficiency_pct: sumBed ? Math.round((100 * sumSleep) / sumBed) : null,
        avg_latency_min: round(mean(vals('latency_min'))),
        avg_wakings: wakings == null ? null : Math.round(wakings * 10) / 10,
        habits_done: habitsDone,
        habits_logged: habitsLogged,
        habits_pct: habitsLogged ? Math.round((100 * habitsDone) / habitsLogged) : null,
        last_day: last ? last.day : null,
        last_sleep_min: last ? last.sleep_min : null,
        last_sleep_hm: last ? last.sleep_hm : null,
        last_asleep_clock: last ? last.asleep_clock : null,
        last_woke_clock: last ? last.woke_clock : null,
        last_change_min: change,
        last_change_label: change == null ? null : change === 0 ? 'No change' : `${change > 0 ? '+' : '−'}${short(Math.abs(change))}`,
        // More sleep is better until 9 hours; less sleep is worse below the guideline.
        last_change_tone: change == null || change === 0 ? 'flat'
          : change > 0 ? (last.sleep_min <= 9 * 60 ? 'good' : 'flat')
          : (last.sleep_min < goalMin ? 'bad' : 'flat'),
        undated: nights.filter((n) => !n.day).length,
      }];
    },
  });

  dash.calc('habit_rates', {
    title: 'Habits kept, by habit',
    description: 'For each habit, how many of the nights in the range it was done, out of the nights it was logged.',
    inputs: ['shown_nights'],
    fn: (shown) => ['sunlight', 'no_screens_before', 'no_screens_after', 'made_bed'].map((habit) => {
      const logged = shown.filter((n) => n[habit] != null).length;
      const done = shown.filter((n) => n[habit] === true).length;
      return {habit, done, logged, pct: logged ? Math.round((100 * done) / logged) : null};
    }),
  });

  // ---------- Helpers for drawings ----------
  const summaryRow = () => {
    const s = dash.data('summary');
    return {status: s.status, row: s.status === 'ok' && Array.isArray(s.data) ? s.data[0] || null : null};
  };
  const textDraw = (name, get) => dash.draw(name, (el) => {
    const {status, row} = summaryRow();
    el.classList.toggle('dash-skeleton', status === 'loading');
    const v = row ? get(row) : null;
    el.textContent = v == null || v === '' ? '—' : String(v);
  });
  const note = (el, text) => {
    const p = document.createElement('p');
    p.className = 'ht-note';
    p.textContent = text;
    el.replaceChildren(p);
  };
  // Returns the rows of each source, or null after showing the state in el.
  const ready = (el, ids) => {
    const list = ids.map((id) => dash.data(id));
    const loading = list.some((d) => d.status === 'loading');
    el.classList.toggle('dash-skeleton', loading);
    if (loading) { el.replaceChildren(); return null; }
    if (list.some((d) => d.status === 'error')) { note(el, 'Couldn’t load the sleep log. Check that the sheet is still published to the web.'); return null; }
    if (list.some((d) => d.status !== 'ok')) { el.textContent = '—'; return null; }
    return list.map((d) => (Array.isArray(d.data) ? d.data : []));
  };
  const makeTip = (el) => {
    const tip = document.createElement('div');
    tip.className = 'ht-tip';
    tip.hidden = true;
    el.appendChild(tip);
    return {
      show(event, title, lines) {
        const t = document.createElement('div');
        t.className = 'ht-tip-title';
        t.textContent = title;
        tip.replaceChildren(t, ...lines.filter(([, v]) => v != null && v !== '').map(([k, v]) => {
          const row = document.createElement('div');
          row.className = 'ht-tip-row';
          const a = document.createElement('span'); a.textContent = k;
          const b = document.createElement('span'); b.textContent = v;
          row.append(a, b);
          return row;
        }));
        tip.hidden = false;
        const box = el.getBoundingClientRect();
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let x = event.clientX - box.left + 14;
        let y = event.clientY - box.top + 14;
        if (x + tw > box.width) x = event.clientX - box.left - tw - 14;
        if (x < 0) x = Math.max(0, Math.min(box.width - tw, event.clientX - box.left - tw / 2));
        if (y + th > box.height) y = event.clientY - box.top - th - 14;
        if (y < 0) y = 0;
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
      },
      hide() { tip.hidden = true; },
    };
  };
  const measure = (svg, texts, cls) => {
    const g = svg.append('g');
    const t = g.selectAll('text').data(texts).join('text').attr('class', cls || null).text((d) => d);
    const w = d3.max(t.nodes(), (n) => n.getComputedTextLength()) || 0;
    g.remove();
    return w;
  };

  // ---------- Words and figures ----------
  textDraw('avg-sleep', (r) => r.avg_sleep_hm);
  textDraw('n-nights', (r) => r.nights_logged);
  textDraw('nights-word', (r) => (r.nights_logged === 1 ? 'night' : 'nights'));
  textDraw('goal-gap', (r) => r.goal_gap_label);
  textDraw('avg-asleep', (r) => r.avg_asleep_clock);
  textDraw('avg-woke', (r) => r.avg_woke_clock);
  textDraw('goal-met', (r) => r.nights_goal_met);
  textDraw('onset-sd', (r) => r.onset_sd_min);
  textDraw('efficiency', (r) => r.efficiency_pct);
  textDraw('latency', (r) => r.avg_latency_min);
  textDraw('wakings', (r) => r.avg_wakings);
  textDraw('habits-pct', (r) => r.habits_pct);
  textDraw('habits-done', (r) => r.habits_done);
  textDraw('habits-logged', (r) => r.habits_logged);
  textDraw('last-sleep', (r) => r.last_sleep_hm);
  textDraw('last-asleep', (r) => r.last_asleep_clock);
  textDraw('last-woke', (r) => r.last_woke_clock);
  textDraw('last-date', (r) => (r.last_day ? fmtDayLong(parseDay(r.last_day)) : null));
  textDraw('range-from', (r) => (r.range_from ? fmtDayShort(parseDay(r.range_from)) : null));
  textDraw('range-to', (r) => (r.range_to ? fmtDayYear(parseDay(r.range_to)) : null));
  textDraw('undated', (r) => r.undated);
  dash.draw('last-change', (el) => {
    const {status, row} = summaryRow();
    el.classList.toggle('dash-skeleton', status === 'loading');
    el.classList.toggle('is-good', !!row && row.last_change_tone === 'good');
    el.classList.toggle('is-bad', !!row && row.last_change_tone === 'bad');
    el.textContent = row && row.last_change_label ? row.last_change_label : '—';
  });
  dash.draw('goal', (el) => { el.textContent = `${GOAL_MIN / 60}h`; });
  const meter = (name, get) => dash.draw(name, (el) => {
    const {status, row} = summaryRow();
    el.classList.toggle('dash-skeleton', status === 'loading');
    el.replaceChildren();
    const m = row ? get(row) : null;
    if (!m || m.value == null || !(m.max > 0)) { el.removeAttribute('role'); el.removeAttribute('aria-label'); return; }
    const fill = document.createElement('span');
    fill.className = 'ht-meter-fill';
    fill.style.width = `${Math.max(0, Math.min(100, (100 * m.value) / m.max))}%`;
    fill.style.background = m.color;
    el.appendChild(fill);
    if (m.goal != null) {
      const g = document.createElement('span');
      g.className = 'ht-meter-goal';
      g.style.left = `${Math.min(100, (100 * m.goal) / m.max)}%`;
      el.appendChild(g);
    }
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', m.label);
  });
  const sleepMeter = (min, hm) => ({
    value: min, max: Math.max(9 * 60, min || 0), goal: GOAL_MIN,
    color: min >= GOAL_MIN ? COLOR.met : COLOR.sleep,
    label: `${hm} asleep, on a scale to 9 hours with the ${GOAL_MIN / 60}-hour guideline marked`,
  });
  meter('last-meter', (r) => sleepMeter(r.last_sleep_min, r.last_sleep_hm));
  meter('avg-meter', (r) => sleepMeter(r.avg_sleep_min, r.avg_sleep_hm));
  meter('eff-meter', (r) => ({value: r.efficiency_pct, max: 100, goal: TARGET_EFFICIENCY, color: r.efficiency_pct >= TARGET_EFFICIENCY ? COLOR.met : COLOR.sleep, label: `${r.efficiency_pct}% of time in bed asleep, target ${TARGET_EFFICIENCY}%`}));
  meter('habits-meter', (r) => ({value: r.habits_pct, max: 100, goal: TARGET_HABITS, color: r.habits_pct >= TARGET_HABITS ? COLOR.met : COLOR.sleep, label: `${r.habits_pct}% of habit check-ins done, target ${TARGET_HABITS}%`}));
  dash.draw('eff-target', (el) => { el.textContent = `${TARGET_EFFICIENCY}%`; });
  dash.draw('habits-target', (el) => { el.textContent = `${TARGET_HABITS}%`; });
  const statusDraw = (name, field, target) => dash.draw(name, (el) => {
    const {status, row} = summaryRow();
    el.classList.toggle('dash-skeleton', status === 'loading');
    const v = row ? row[field] : null;
    el.textContent = v == null ? '—' : v >= target ? 'On target' : 'Below target';
  });
  statusDraw('eff-status', 'efficiency_pct', TARGET_EFFICIENCY);
  statusDraw('habits-status', 'habits_pct', TARGET_HABITS);
  dash.draw('window', (el) => { el.textContent = RANGE_LABELS[dash.params().range ?? '30'] || 'chosen range'; });

  // ---------- Sleep schedule ----------
  dash.draw('schedule', (el) => {
    const got = ready(el, ['shown_nights', 'summary']);
    if (!got) return;
    const [shown, sum] = got;
    const s = sum[0] || {};
    const nights = shown.filter((n) => (n.bed_t ?? n.asleep_t) != null && (n.up_t ?? n.woke_t) != null).slice().reverse();
    if (!nights.length) { note(el, 'No nights with bed and wake times in this range yet.'); return; }
    el.replaceChildren();
    const width = Math.max(260, el.clientWidth || 600);
    const rowH = nights.length > 45 ? 12 : nights.length > 20 ? 18 : 30;
    const barH = Math.max(6, Math.round(rowH * 0.56));
    const top = 6, bottom = 26;
    const height = top + bottom + nights.length * rowH;
    const svg = d3.select(el).append('svg')
      .attr('class', 'ht-svg').attr('width', '100%').attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img')
      .attr('aria-label', `Sleep schedule for ${nights.length} night${nights.length === 1 ? '' : 's'}: time in bed and time asleep each night, newest at the top.`);
    const fmtY = width < 420 ? fmtDayShort : fmtDayAxis;
    const yLabel = (n) => fmtY(parseDay(n.day));
    const showValues = rowH >= 18;
    const left = Math.ceil(measure(svg, nights.map(yLabel))) + 10;
    const right = showValues ? Math.ceil(measure(svg, nights.map((n) => n.sleep_hm || ''), 'ht-val')) + 12 : 8;
    const lo = Math.floor((d3.min(nights, (n) => n.bed_t ?? n.asleep_t) - 20) / 60) * 60;
    const hi = Math.ceil((d3.max(nights, (n) => n.up_t ?? n.woke_t) + 20) / 60) * 60;
    const x = d3.scaleLinear().domain([lo, hi]).range([left, width - right]);
    const y = (i) => top + i * rowH;
    const pxPerHour = (x(hi) - x(lo)) / ((hi - lo) / 60);
    const step = pxPerHour >= 44 ? 60 : pxPerHour >= 24 ? 120 : 180;
    const ticks = d3.range(lo, hi + 1, step);

    svg.append('g').selectAll('rect').data(nights.map((n, i) => i).filter((i) => i % 2 === 1)).join('rect')
      .attr('x', 0).attr('width', width).attr('y', (i) => y(i)).attr('height', rowH).attr('rx', 4).style('fill', COLOR.stripe);
    svg.append('g').selectAll('line').data(ticks).join('line')
      .attr('x1', (d) => x(d)).attr('x2', (d) => x(d)).attr('y1', top).attr('y2', height - bottom)
      .style('stroke', 'var(--cds-chart-grid)').attr('stroke-width', 1);
    svg.append('g').selectAll('text').data(ticks).join('text')
      .attr('x', (d) => x(d)).attr('y', height - bottom + 17).attr('text-anchor', 'middle').text(clockLabel);

    const hover = svg.append('rect').attr('x', 0).attr('width', width).attr('height', rowH)
      .style('fill', 'var(--color-fg)').style('opacity', 0).attr('pointer-events', 'none');

    [s.avg_asleep_t, s.avg_woke_t].filter((v) => v != null && v >= lo && v <= hi).forEach((v) => {
      svg.append('line').attr('x1', x(v)).attr('x2', x(v)).attr('y1', top).attr('y2', height - bottom)
        .style('stroke', 'var(--cds-chart-reference)').attr('stroke-width', 1.5).attr('stroke-dasharray', '4 3');
    });

    const segs = [];
    nights.forEach((n, i) => {
      const add = (a, b, kind) => { if (a != null && b != null && b > a) segs.push({i, a, b, kind}); };
      add(n.bed_t, n.asleep_t, 'awake');
      add(n.asleep_t, n.woke_t, 'asleep');
      add(n.woke_t, n.up_t, 'awake');
    });
    const r = Math.min(4, barH / 2);
    svg.append('g').selectAll('rect').data(segs).join('rect')
      .attr('x', (d) => x(d.a) + 1).attr('width', (d) => Math.max(1.5, x(d.b) - x(d.a) - 2))
      .attr('y', (d) => y(d.i) + (rowH - barH) / 2).attr('height', barH).attr('rx', r)
      .style('fill', (d) => (d.kind === 'asleep' ? COLOR.sleep : COLOR.awake));

    const every = Math.max(1, Math.ceil(14 / rowH));
    svg.append('g').selectAll('text').data(nights.map((n, i) => ({n, i})).filter((d) => d.i % every === 0)).join('text')
      .attr('x', left - 10).attr('y', (d) => y(d.i) + rowH / 2).attr('dy', '0.35em').attr('text-anchor', 'end')
      .text((d) => yLabel(d.n));
    if (showValues) {
      svg.append('g').selectAll('text').data(nights.map((n, i) => ({n, i})).filter((d) => d.n.sleep_hm)).join('text')
        .attr('class', 'ht-val')
        .attr('x', (d) => x(d.n.up_t ?? d.n.woke_t) + 6).attr('y', (d) => y(d.i) + rowH / 2).attr('dy', '0.35em')
        .text((d) => d.n.sleep_hm);
    }

    const tip = makeTip(el);
    svg.append('g').selectAll('rect').data(nights.map((n, i) => ({n, i}))).join('rect')
      .attr('x', 0).attr('width', width).attr('y', (d) => y(d.i)).attr('height', rowH)
      .style('fill', 'transparent').style('cursor', 'default')
      .on('pointerenter pointermove', (event, d) => {
        hover.attr('y', y(d.i)).style('opacity', 0.05);
        const n = d.n;
        tip.show(event, fmtDayLong(parseDay(n.day)), [
          ['In bed', n.bed_clock], ['Fell asleep', n.asleep_clock], ['Woke up', n.woke_clock], ['Out of bed', n.up_clock],
          ['Time asleep', n.sleep_hm], ['Time in bed', n.in_bed_hm],
          ['Efficiency', n.efficiency_pct != null ? `${n.efficiency_pct}%` : null],
          ['Night wakings', n.wakings != null ? `${n.wakings}${n.wakings_note ? ` (${n.wakings_note})` : ''}` : n.wakings_note],
          ['Notes', n.notes],
        ]);
      })
      .on('pointerleave', () => { hover.style('opacity', 0); tip.hide(); });
  });

  // ---------- Hours asleep ----------
  dash.draw('duration', (el) => {
    const got = ready(el, ['shown_nights']);
    if (!got) return;
    const nights = got[0].filter((n) => n.sleep_min != null);
    if (!nights.length) { note(el, 'No nights with sleep and wake times in this range yet.'); return; }
    el.replaceChildren();
    const width = Math.max(260, el.clientWidth || 500);
    const height = 240;
    const top = 18, bottom = 26;
    const svg = d3.select(el).append('svg')
      .attr('class', 'ht-svg').attr('width', '100%').attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img')
      .attr('aria-label', `Hours asleep for each of ${nights.length} night${nights.length === 1 ? '' : 's'}, against the ${GOAL_MIN / 60}-hour guideline.`);
    const showAvg = nights.length >= 7 && nights.some((n) => n.avg7_min != null);
    const yTop = Math.ceil(Math.max(9 * 60, GOAL_MIN + 60, d3.max(nights, (n) => n.sleep_min) + 30) / 120) * 120;
    const yTicks = d3.range(0, yTop + 1, 120);
    const y = d3.scaleLinear().domain([0, yTop]).range([height - bottom, top]);
    const tickText = (m) => `${m / 60}h`;
    const goalText = `${GOAL_MIN / 60}h`;
    const left = Math.ceil(measure(svg, yTicks.map(tickText))) + 10;
    const right = Math.ceil(measure(svg, [goalText])) + 10;
    const x = d3.scaleBand().domain(nights.map((n, i) => i)).range([left, width - right]).paddingInner(0.28).paddingOuter(0.14);
    const bw = Math.min(x.bandwidth(), 44);
    const cx = (i) => x(i) + x.bandwidth() / 2;

    svg.append('g').selectAll('line').data(yTicks).join('line')
      .attr('x1', left).attr('x2', width - right).attr('y1', (d) => y(d)).attr('y2', (d) => y(d))
      .style('stroke', (d) => (d === 0 ? 'var(--cds-chart-axis)' : 'var(--cds-chart-grid)')).attr('stroke-width', 1);
    svg.append('g').selectAll('text').data(yTicks).join('text')
      .attr('x', left - 8).attr('y', (d) => y(d)).attr('dy', '0.35em').attr('text-anchor', 'end').text(tickText);

    const hover = svg.append('rect').attr('y', top).attr('height', height - bottom - top)
      .style('fill', 'var(--color-fg)').style('opacity', 0).attr('pointer-events', 'none');

    svg.append('rect').attr('x', left).attr('width', width - right - left)
      .attr('y', y(yTop)).attr('height', y(GOAL_MIN) - y(yTop)).style('fill', COLOR.zone);

    const barPath = (n, i) => {
      const x0 = cx(i) - bw / 2, y0 = y(0), y1 = y(n.sleep_min), rr = Math.min(4, bw / 2, y0 - y1);
      return `M${x0},${y0}V${y1 + rr}Q${x0},${y1} ${x0 + rr},${y1}H${x0 + bw - rr}Q${x0 + bw},${y1} ${x0 + bw},${y1 + rr}V${y0}Z`;
    };
    svg.append('g').selectAll('path').data(nights).join('path')
      .attr('d', (n, i) => barPath(n, i)).style('fill', (n) => (n.sleep_min >= GOAL_MIN ? COLOR.met : COLOR.sleep));

    svg.append('line').attr('x1', left).attr('x2', width - right).attr('y1', y(GOAL_MIN)).attr('y2', y(GOAL_MIN))
      .style('stroke', 'var(--cds-chart-reference)').attr('stroke-width', 1.5).attr('stroke-dasharray', '4 3');
    svg.append('text').attr('x', width - right + 6).attr('y', y(GOAL_MIN)).attr('dy', '0.35em').text(goalText);

    if (showAvg) {
      const pts = nights.map((n, i) => ({i, v: n.avg7_min})).filter((d) => d.v != null);
      svg.append('path').datum(pts)
        .attr('d', d3.line().x((d) => cx(d.i)).y((d) => y(d.v)))
        .style('fill', 'none').style('stroke', COLOR.ink).style('opacity', 0.75).attr('stroke-width', 2).attr('stroke-linejoin', 'round');
    }

    const labelW = measure(svg, nights.map((n) => n.sleep_hm), 'ht-val');
    if (x.step() >= labelW + 6) {
      svg.append('g').selectAll('text').data(nights).join('text').attr('class', 'ht-val')
        .attr('x', (n, i) => cx(i)).attr('y', (n) => y(n.sleep_min) - 6).attr('text-anchor', 'middle').text((n) => n.sleep_hm);
    }

    const fmtX = d3.utcFormat('%b %-d');
    const xw = measure(svg, nights.map((n) => fmtX(parseDay(n.day))));
    const every = Math.max(1, Math.ceil((xw + 10) / x.step()));
    svg.append('g').selectAll('text').data(nights.map((n, i) => ({n, i})).filter((d) => (nights.length - 1 - d.i) % every === 0)).join('text')
      .attr('x', (d) => cx(d.i)).attr('y', height - bottom + 17).attr('text-anchor', 'middle')
      .text((d) => fmtX(parseDay(d.n.day)));

    const tip = makeTip(el);
    svg.append('g').selectAll('rect').data(nights.map((n, i) => ({n, i}))).join('rect')
      .attr('x', (d) => x(d.i) - (x.step() - x.bandwidth()) / 2).attr('width', x.step())
      .attr('y', top).attr('height', height - bottom - top).style('fill', 'transparent')
      .on('pointerenter pointermove', (event, d) => {
        hover.attr('x', x(d.i) - (x.step() - x.bandwidth()) / 2).attr('width', x.step()).style('opacity', 0.05);
        const n = d.n;
        const diff = n.sleep_min - GOAL_MIN;
        const abs = Math.abs(diff);
        const diffText = diff === 0 ? 'On the guideline' : `${abs >= 60 ? `${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, '0')}m` : `${abs} min`} ${diff < 0 ? 'under' : 'over'} ${goalText}`;
        const avgText = n.avg7_min != null ? `${Math.floor(n.avg7_min / 60)}h ${String(n.avg7_min % 60).padStart(2, '0')}m` : null;
        tip.show(event, fmtDayLong(parseDay(n.day)), [
          ['Time asleep', n.sleep_hm], ['Against guideline', diffText], ['7-night average', avgText],
        ]);
      })
      .on('pointerleave', () => { hover.style('opacity', 0); tip.hide(); });
  });

  // ---------- Habits ----------
  const habitLayout = (width, count) => {
    const gap = count > 40 ? 1 : count > 20 ? 2 : 4;
    const cell = Math.max(3, Math.min(22, Math.floor((width + gap) / Math.max(1, count)) - gap));
    return {gap, cell, total: count * (cell + gap) - gap};
  };
  dash.draw('habit-cells', (el) => {
    const got = ready(el, ['shown_nights']);
    if (!got) return;
    const nights = got[0];
    const key = el.dataset.habit;
    el.replaceChildren();
    if (!nights.length) { el.textContent = '—'; return; }
    const width = Math.max(60, el.clientWidth || 200);
    const {gap, cell, total} = habitLayout(width, nights.length);
    const name = (el.closest('.ht-habit') && el.closest('.ht-habit').querySelector('.ht-habit-name') || {}).textContent || key;
    const done = nights.filter((n) => n[key] === true).length;
    const svg = d3.select(el).append('svg').attr('class', 'ht-svg')
      .attr('width', '100%').attr('height', cell).attr('viewBox', `0 0 ${Math.max(width, total)} ${cell}`)
      .attr('preserveAspectRatio', 'xMinYMid meet').attr('role', 'img')
      .attr('aria-label', `${name}: done on ${done} of ${nights.length} nights, oldest first.`);
    const rr = Math.min(4, cell / 4);
    const g = svg.append('g').selectAll('g').data(nights.map((n, i) => ({n, i}))).join('g')
      .attr('transform', (d) => `translate(${d.i * (cell + gap)},0)`);
    g.filter((d) => d.n[key] === true).append('rect')
      .attr('width', cell).attr('height', cell).attr('rx', rr).style('fill', COLOR.met);
    g.filter((d) => d.n[key] === false).append('rect')
      .attr('x', 0.75).attr('y', 0.75).attr('width', cell - 1.5).attr('height', cell - 1.5).attr('rx', rr)
      .style('fill', 'none').style('stroke', 'var(--cds-chart-muted)').attr('stroke-width', 1.5);
    g.filter((d) => d.n[key] == null).append('circle')
      .attr('cx', cell / 2).attr('cy', cell / 2).attr('r', Math.max(1, cell / 8)).style('fill', 'var(--cds-chart-muted)');
    const tip = makeTip(el);
    g.append('rect').attr('x', -gap / 2).attr('y', -4).attr('width', cell + gap).attr('height', cell + 8).style('fill', 'transparent')
      .on('pointerenter pointermove', (event, d) => {
        const v = d.n[key];
        tip.show(event, fmtDayLong(parseDay(d.n.day)), [[name, v === true ? 'Done' : v === false ? 'Skipped' : 'Not logged']]);
      })
      .on('pointerleave', () => tip.hide());
  });
  const habitText = (name, field) => dash.draw(name, (el) => {
    const d = dash.data('habit_rates');
    el.classList.toggle('dash-skeleton', d.status === 'loading');
    const row = d.status === 'ok' && Array.isArray(d.data) ? d.data.find((r) => r.habit === el.dataset.habit) : null;
    el.textContent = row && row[field] != null ? String(row[field]) : '—';
  });
  habitText('habit-pct', 'pct');
  habitText('habit-done', 'done');
  habitText('habit-logged', 'logged');
  dash.draw('habit-dates', (el) => {
    const d = dash.data('shown_nights');
    const nights = d.status === 'ok' && Array.isArray(d.data) ? d.data : [];
    el.replaceChildren();
    if (!nights.length) return;
    const width = Math.max(60, el.clientWidth || 200);
    const {total} = habitLayout(width, nights.length);
    const box = document.createElement('div');
    box.style.width = `${Math.min(width, total)}px`;
    const first = document.createElement('span');
    first.textContent = fmtDayShort(parseDay(nights[0].day));
    box.appendChild(first);
    if (nights.length > 1) {
      const last = document.createElement('span');
      last.textContent = fmtDayShort(parseDay(nights[nights.length - 1].day));
      box.appendChild(last);
    }
    el.appendChild(box);
  });

  // ---------- Night log ----------
  dash.draw('log-rows', (tbody) => {
    const d = dash.data('shown_nights');
    const cols = 12;
    const message = (text) => {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = cols;
      td.className = 'ht-muted';
      td.textContent = text;
      tr.appendChild(td);
      tbody.replaceChildren(tr);
    };
    if (d.status === 'loading') { message('Loading…'); return; }
    if (d.status === 'error') { message('Couldn’t load the sleep log. Check that the sheet is still published to the web.'); return; }
    if (d.status !== 'ok') { message('—'); return; }
    const nights = (Array.isArray(d.data) ? d.data : []).slice().reverse();
    if (!nights.length) { message('No nights in this range yet.'); return; }
    const key = (v) => String(v ?? '').replace(/[%&=,]/g, (c) => encodeURIComponent(c));
    tbody.replaceChildren(...nights.map((n) => {
      const tr = document.createElement('tr');
      tr.dataset.key = key(n.date);
      const cells = [
        [fmtDayLong(parseDay(n.day)), ''],
        [n.bed_clock, ''], [n.asleep_clock, ''], [n.woke_clock, ''], [n.up_clock, ''],
        [n.sleep_hm, 'ht-num', n.sleep_min == null ? null : n.sleep_min >= GOAL_MIN ? COLOR.met : COLOR.sleep], [n.in_bed_hm, 'ht-num'],
        [n.efficiency_pct != null ? `${n.efficiency_pct}%` : null, 'ht-num'],
        [n.latency_min != null ? `${n.latency_min} min` : null, 'ht-num'],
        [n.wakings, 'ht-num'],
        [n.habits_label, 'ht-num'],
        [n.notes, 'ht-note-cell'],
      ];
      cells.forEach(([v, cls, dot]) => {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = v == null || v === '' ? '—' : String(v);
        if (dot) {
          const d = document.createElement('span');
          d.className = 'ht-dot';
          d.setAttribute('aria-hidden', 'true');
          d.style.background = dot;
          td.prepend(d);
        }
        tr.appendChild(td);
      });
      return tr;
    }));
  });

  // ---------- Controls and page state ----------
  const currentRange = () => String(dash.params().range ?? '30');
  document.querySelectorAll('.ht-range').forEach((sel) => {
    sel.value = currentRange();
    sel.addEventListener('change', () => dash.setParams({range: sel.value}));
  });

  // Light or dark: read the theme's text color and switch the palette to match.
  const applyTheme = () => {
    document.querySelectorAll('.ht').forEach((root) => {
      const c = getComputedStyle(root).color || '';
      const n = (c.match(/-?\d*\.?\d+/g) || []).map(Number);
      let light = null;
      if (/^rgba?\(/.test(c) && n.length >= 3) light = (0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]) / 255;
      else if (/^color\(/.test(c) && n.length >= 3) light = 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
      else if (/^(ok)?l(ab|ch)\(/.test(c) && n.length) light = n[0] > 1 ? n[0] / 100 : n[0];
      root.classList.toggle('ht-dark', light != null && light > 0.5);
    });
  };
  applyTheme();
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    const watch = new MutationObserver(applyTheme);
    [document.documentElement, document.body].forEach((node) => node && watch.observe(node, {attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-mode']}));
  } catch (e) { /* theme stays as first read */ }

  dash.onData(() => {
    applyTheme();
    document.querySelectorAll('.ht-range').forEach((sel) => { if (document.activeElement !== sel) sel.value = currentRange(); });
    const s = dash.data('summary');
    const row = s.status === 'ok' && Array.isArray(s.data) ? s.data[0] : null;
    const empty = s.status === 'ok' && (!row || !row.nights_logged);
    document.querySelectorAll('#ht-lede').forEach((p) => { p.hidden = empty; });
    document.querySelectorAll('#ht-empty').forEach((p) => { p.hidden = !empty; });
    document.querySelectorAll('#ht-undated').forEach((p) => { p.hidden = !(row && row.undated > 0); });
    const tone = (id, v, target) => document.querySelectorAll(`#${id}`).forEach((card) => {
      card.classList.toggle('is-met', v != null && v >= target);
      card.classList.toggle('is-below', v != null && v < target);
    });
    tone('kpi-efficiency', row ? row.efficiency_pct : null, TARGET_EFFICIENCY);
    tone('kpi-habits', row ? row.habits_pct : null, TARGET_HABITS);
    const shown = dash.data('shown_nights');
    const withSleep = shown.status === 'ok' && Array.isArray(shown.data) ? shown.data.filter((n) => n.sleep_min != null) : [];
    const enough = withSleep.length >= 7 && withSleep.some((n) => n.avg7_min != null);
    document.querySelectorAll('#avg7-key').forEach((k) => { k.hidden = !enough; });
  });
})();
