"""
Build presentation-ready charts from a paper-mode log file.

Usage: python observation/plot_run.py logs/paper-<timestamp>.log

Writes PNGs to logs/charts/.
"""
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.dates as mdates

LOG_PATH = Path(sys.argv[1] if len(sys.argv) > 1
                else 'logs/paper-2026-05-03T01-11-19-278Z.log')
OUT_DIR = Path('logs/charts')
OUT_DIR.mkdir(parents=True, exist_ok=True)

TS = re.compile(r'^(\S+)Z')

def parse_ts(s):
    return datetime.fromisoformat(s.rstrip('Z'))


# Data containers
events = []          # [(t, home, away, period, clock_str)]
fair = []            # [(t, market, fair, delta_pp, confidence)]
opens = []           # [(t, side, entry, target)]
exits = []           # [(t, pnl)]

re_score = re.compile(
    r'(\S+)Z LOG \[pipeline\] score change \| NBA \S+ \| (\w+) (\d+) @ (\w+) (\d+) \| (Q\d) (\S+)'
)
re_fair = re.compile(
    r'(\S+)Z LOG \[pipeline\] fair-value \| \S+ market=(\d+)c fair=(\d+)c '
    r'Δ=(-?\d+\.\d+)pp confidence=(\w+)'
)
re_open = re.compile(
    r'(\S+)Z LOG \[pipeline\] open position \| \S+ (yes|no) qty=\d+ entry=(\d+)c target=(\d+)c'
)
re_exit = re.compile(
    r'(\S+)Z LOG \[pipeline\] EXIT \S+ \| pnl=(-?\d+|\+\d+)c'
)

with LOG_PATH.open(encoding='utf-8') as f:
    for line in f:
        m = re_score.match(line)
        if m:
            t, away_team, away_score, home_team, home_score, period, clock = m.groups()
            events.append((parse_ts(t), int(home_score), int(away_score), period, clock))
            continue
        m = re_fair.match(line)
        if m:
            t, market, fair_p, delta, conf = m.groups()
            fair.append((parse_ts(t), int(market), int(fair_p), float(delta), conf))
            continue
        m = re_open.match(line)
        if m:
            t, side, entry, target = m.groups()
            opens.append((parse_ts(t), side, int(entry), int(target)))
            continue
        m = re_exit.match(line)
        if m:
            t, pnl = m.groups()
            exits.append((parse_ts(t), int(pnl)))

print(f'parsed: {len(events)} events  {len(fair)} fair-values  '
      f'{len(opens)} opens  {len(exits)} exits')

# ─────────────────────────────────────────────────────────────────
# Chart 1: BOS Kalshi mid + score progression
# ─────────────────────────────────────────────────────────────────
fig, (ax_score, ax_price) = plt.subplots(
    2, 1, figsize=(12, 7), sharex=True,
    gridspec_kw={'height_ratios': [1, 2]},
)

# Top panel: home/away scores over time
ts_score = [e[0] for e in events]
home_s   = [e[1] for e in events]
away_s   = [e[2] for e in events]
ax_score.step(ts_score, home_s, where='post', color='#0E7C7B', label='BOS (home)', linewidth=2)
ax_score.step(ts_score, away_s, where='post', color='#D7263D', label='PHI (away)', linewidth=2)
ax_score.set_ylabel('Score')
ax_score.legend(loc='upper left')
ax_score.set_title('PHI @ BOS — Game 7 (1st-Round) — 2026-05-02')
ax_score.grid(alpha=0.3)

# Bottom panel: BOS contract market and model fair value
ts_fair    = [f[0] for f in fair]
market_p   = [f[1] for f in fair]
fair_p     = [f[2] for f in fair]
ax_price.plot(ts_fair, market_p, color='#0E7C7B', linewidth=1.8,
              label='BOS contract — Kalshi mid')
ax_price.plot(ts_fair, fair_p, color='#FF9F1C', linewidth=1.2, linestyle='--',
              label='Model estimated fair', alpha=0.75)
ax_price.fill_between(ts_fair, market_p, fair_p, alpha=0.12, color='#FF9F1C')

# Mark exits with green/red dots on the price line
for t, pnl in exits:
    color = '#1E8449' if pnl > 0 else '#C0392B' if pnl < 0 else '#7F8C8D'
    ax_price.axvline(t, color=color, alpha=0.18, linewidth=1)
ax_price.set_ylabel('Cents (0–100)')
ax_price.set_ylim(0, 100)
ax_price.legend(loc='upper right')
ax_price.grid(alpha=0.3)
ax_price.xaxis.set_major_formatter(mdates.DateFormatter('%H:%M'))

plt.tight_layout()
plt.savefig(OUT_DIR / '01_market_vs_score.png', dpi=150, bbox_inches='tight')
plt.close()

# ─────────────────────────────────────────────────────────────────
# Chart 2: Cumulative simulated P&L
# ─────────────────────────────────────────────────────────────────
if exits:
    fig, ax = plt.subplots(figsize=(12, 5))
    cum = 0
    cum_x, cum_y = [exits[0][0]], [0]
    per_trade_x, per_trade_pnl = [], []
    for t, pnl in exits:
        cum += pnl
        cum_x.append(t); cum_y.append(cum)
        per_trade_x.append(t); per_trade_pnl.append(pnl)

    ax.plot(cum_x, cum_y, color='#1F4E79', linewidth=2, label='Cumulative simulated P&L')
    ax.fill_between(cum_x, cum_y, 0,
                    where=[y >= 0 for y in cum_y], color='#1E8449', alpha=0.15)
    ax.fill_between(cum_x, cum_y, 0,
                    where=[y < 0 for y in cum_y], color='#C0392B', alpha=0.15)

    # Per-trade dots colored by win/loss
    colors = ['#1E8449' if p > 0 else '#C0392B' if p < 0 else '#7F8C8D'
              for p in per_trade_pnl]
    # Place each dot on the cumulative line at exit time
    cum_at_exit = []
    running = 0
    for p in per_trade_pnl:
        running += p
        cum_at_exit.append(running)
    ax.scatter(per_trade_x, cum_at_exit, c=colors, s=70, zorder=5,
               edgecolor='white', linewidth=1.2)

    ax.axhline(0, color='black', linewidth=0.5)
    ax.set_ylabel('Cumulative P&L (cents)')
    ax.set_title('Simulated P&L over the live PHI@BOS run (16 closed trades)')
    ax.legend(loc='upper left')
    ax.grid(alpha=0.3)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%H:%M'))

    plt.tight_layout()
    plt.savefig(OUT_DIR / '02_cumulative_pnl.png', dpi=150, bbox_inches='tight')
    plt.close()

# ─────────────────────────────────────────────────────────────────
# Chart 3: Per-trade outcomes (bar chart)
# ─────────────────────────────────────────────────────────────────
if exits:
    fig, ax = plt.subplots(figsize=(11, 5))
    pnls = [p for _, p in exits]
    indices = list(range(1, len(pnls) + 1))
    colors = ['#1E8449' if p > 0 else '#C0392B' if p < 0 else '#7F8C8D' for p in pnls]
    bars = ax.bar(indices, pnls, color=colors, edgecolor='white', linewidth=0.8)

    # Annotations
    for bar, pnl in zip(bars, pnls):
        height = bar.get_height()
        offset = 5 if height >= 0 else -5
        va = 'bottom' if height >= 0 else 'top'
        ax.annotate(f'{pnl:+d}', xy=(bar.get_x() + bar.get_width() / 2, height),
                    xytext=(0, offset), textcoords='offset points',
                    ha='center', va=va, fontsize=9)

    total = sum(pnls)
    wins = sum(1 for p in pnls if p > 0)
    losses = sum(1 for p in pnls if p < 0)
    ax.axhline(0, color='black', linewidth=0.5)
    ax.set_xlabel('Closed trade number (chronological)')
    ax.set_ylabel('Realized P&L per trade (cents, 10-contract sizing)')
    ax.set_title(f'Per-trade outcomes — total {total:+d}c, {wins}W / {losses}L / '
                 f'{len(pnls)-wins-losses}flat')
    ax.grid(axis='y', alpha=0.3)

    plt.tight_layout()
    plt.savefig(OUT_DIR / '03_per_trade_pnl.png', dpi=150, bbox_inches='tight')
    plt.close()

print('charts written to', OUT_DIR.resolve())
for f in sorted(OUT_DIR.glob('*.png')):
    print(' ', f.name, f.stat().st_size, 'bytes')
