# Warning Watch

A public early-warning watch on one signal: the people with the most to lose
and the best information move first, and they move by air. Every half hour it
counts the world's business jets and military aircraft in the air, from the
ADS-B Exchange archive, scores each count against its own seasonal baseline,
and alerts subscribers when a count leaves that baseline by more than a stated
threshold.

The watch reports what changed and what remains unverified. It does not
estimate the probability of war or infer any one person's intent, and a quiet
page never means nothing happened. Alerts carry the measurement, its
uncertainty, and the strongest alternative explanation.

## How it works

```
ADS-B Exchange heatmaps ──► three cohorts ──► seasonal baselines ──► alert_events ──► subscribers
 (30-minute slots,           business jets      takeoff volume           │       ntfy · RSS · Telegram
  checked every 2 min)       military           turnaround clusters      │       email · SMS · web push
                             unregistered hex   departure clusters       └── cohorts must agree for critical
```

- **Two gates on every public alert**: a statistical departure *and* an
  absolute magnitude. No baseline, no alert.
- **Missing data is not safety**: an archive that stops answering pages the
  operator and says so on the public page.
- **Keyed fanout with a firing record**: repeated samples do not create new
  evidence; an event that rises to a higher severity is delivered again, and
  every delivery is a row in `publications`.
- Dashboard JSON is published at `/dashboard.json`, `/military-dashboard.json`
  and `/untracked-dashboard.json`.
- The whole pipeline is one command (`npm run refresh:all`), designed to run
  from any scheduler on one cheap box.

## Quickstart

```sh
npm ci
cp .env.example .env          # defaults work for local use
npm run refresh:all           # ingest latest slot, detect, export feeds
npm run build && npm start    # page, dashboard JSON and RSS at http://127.0.0.1:3030/
```

Python 3 with `numpy` and `Pillow` is needed for ingestion
(`pip install -r requirements.txt`). Baselines need ~7 days of history before
anomaly models arm; `scripts/backfill_history.py --start-date … --end-date …`
fills history from public archives. Polling every two minutes does **not**
make those 30-minute archives a real-time feed.

## Subscribing (for a running deployment)

| Channel | How |
|---|---|
| ntfy push | install the [ntfy](https://ntfy.sh) app, subscribe to the deployment's topic |
| RSS | `<deployment>/rss.xml` in any feed reader |
| Telegram | join the deployment's channel |
| Browser push | the front page's sign-up panel |
| Email / SMS | the same panel, once the deployment sets its Postmark token and sender, or its Telnyx key and number |

## Operations

See [OPERATIONS.md](OPERATIONS.md) for deployment, resource bounds, access, and
recovery. [ROADMAP.md](ROADMAP.md) records the instrument's calibration work.

## Provenance

This is an independent recreation, with a self-hostable backend, inspired by
[Kyle McDonald's Apocalypse Early Warning System](https://ews.kylemcdonald.net/).
It is not affiliated with or endorsed by the original. Aircraft data comes from
ADS-B Exchange's public interfaces.

## License

MIT — see [LICENSE](LICENSE).
