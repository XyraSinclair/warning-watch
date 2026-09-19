// Underground-detonation rule over the USGS catalogue. Pure: no I/O beyond the
// site list, so the collector (which must keep small events near a test site)
// and the detector (which judges them) share one definition.
//
// What the record says (USGS ComCat, measured 19 Sept 2026): all six North
// Korean tests are catalogued as `nuclear explosion` at depth 0, M4.3-6.3.
// Within 50 km of the listed sites since 2000 there are 25 natural earthquakes
// of M>=3.5, about one a year; one of them is shallower than 5 km, and that one
// was induced by the 2017 test. Worldwide, no event of M>=4 was typed
// `explosion` in the year to 19 Sept 2026. So: location plus shallowness is a
// near-zero false-alarm surface, location alone is about one a year, and the
// agency's own classification is decisive wherever it happens.
//
// What this cannot see: an atmospheric or high-altitude burst, a test too
// small or too remote for the global network, and, until USGS classifies it,
// a test anywhere not listed in config/nuclear-test-sites.json.

const { sites } = require('../config/nuclear-test-sites.json');

const SITE_MIN_MAGNITUDE = 3.5;
const EXPLOSION_MIN_MAGNITUDE = 4;
const SHALLOW_KM = 5;
// USGS fixes depth at 10 km when the data cannot constrain it.
const UNCONSTRAINED_DEPTH_KM = 10;
const SEISMIC_SOURCE_TYPES = new Set(['earthquake', 'explosion', 'collapse', 'other event']);

function distanceKm(latA, lonA, latB, lonB) {
  const rad = (degrees) => (degrees * Math.PI) / 180;
  const a = Math.sin(rad(latB - latA) / 2) ** 2 + Math.cos(rad(latA)) * Math.cos(rad(latB)) * Math.sin(rad(lonB - lonA) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function nearTestSite(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let nearest = null;
  for (const site of sites) {
    const km = distanceKm(site.lat, site.lon, lat, lon);
    if (km <= site.radius_km && (!nearest || km < nearest.distanceKm)) nearest = { site, distanceKm: km };
  }
  return nearest;
}

// The collector's question: is this small event worth keeping?
function nearTestSiteCandidate(magnitude, lat, lon) {
  return Number.isFinite(magnitude) && magnitude >= SITE_MIN_MAGNITUDE && nearTestSite(lat, lon) !== null;
}

// -> null (nothing to say) or { level, rule, site, distanceKm, depth }.
// Levels are the shared scale: 5 critical, 4 high, 3 elevated, 1 operator-only.
function assessSeismicEvent({ classification, magnitude, lat, lon, depthKm }) {
  if (classification === 'nuclear explosion') {
    const near = nearTestSite(lat, lon);
    return { level: 5, rule: 'agency_classified_nuclear', site: near?.site ?? null, distanceKm: near?.distanceKm ?? null, depth: 'as reported' };
  }
  if (!Number.isFinite(magnitude) || !SEISMIC_SOURCE_TYPES.has(classification)) return null;
  const near = nearTestSite(lat, lon);
  if (near && magnitude >= SITE_MIN_MAGNITUDE) {
    const unconstrained = !Number.isFinite(depthKm) || depthKm === UNCONSTRAINED_DEPTH_KM;
    const shallow = Number.isFinite(depthKm) && depthKm <= SHALLOW_KM;
    const level = classification === 'explosion' || shallow ? 4 : unconstrained ? 3 : 1;
    return { level, rule: 'test_site_geofence', site: near.site, distanceKm: near.distanceKm, depth: shallow ? 'shallow' : unconstrained ? 'unconstrained' : 'deep' };
  }
  if (classification === 'explosion' && magnitude >= EXPLOSION_MIN_MAGNITUDE) {
    return { level: 3, rule: 'agency_classified_explosion', site: null, distanceKm: null, depth: 'as reported' };
  }
  return null;
}

module.exports = { assessSeismicEvent, nearTestSite, nearTestSiteCandidate, SITE_MIN_MAGNITUDE, EXPLOSION_MIN_MAGNITUDE, SHALLOW_KM };
