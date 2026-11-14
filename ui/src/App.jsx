import { useEffect, useMemo, useRef, useState } from "react";

const INITIAL_FORMULA = {
  quote: 780,
  driverFee: 432,
  returnCost: 44,
  lateRisk: 32,
  synergy: 48,
  capacity: 64,
};

const CITY_DATA = [
  { id: "rovaniemi", name: "Rovaniemi", lat: 66.5039, lon: 25.7294, label: "right" },
  { id: "oulu", name: "Oulu", lat: 65.0121, lon: 25.4651, label: "left" },
  { id: "vaasa", name: "Vaasa", lat: 63.0951, lon: 21.6165, label: "left" },
  { id: "kuopio", name: "Kuopio", lat: 62.8924, lon: 27.677, label: "right" },
  { id: "joensuu", name: "Joensuu", lat: 62.601, lon: 29.7636, label: "right" },
  { id: "jyvaskyla", name: "Jyväskylä", lat: 62.2426, lon: 25.7473, label: "right" },
  { id: "tampere", name: "Tampere", lat: 61.4981, lon: 23.7608, label: "left" },
  { id: "turku", name: "Turku", lat: 60.4518, lon: 22.2666, label: "left" },
  { id: "helsinki", name: "Helsinki", lat: 60.1699, lon: 24.9384, label: "below" },
  { id: "pori", name: "Pori", lat: 61.4851, lon: 21.7974 },
  { id: "lahti", name: "Lahti", lat: 60.9827, lon: 25.6615 },
  { id: "mikkeli", name: "Mikkeli", lat: 61.6886, lon: 27.2723 },
  { id: "lappeenranta", name: "Lappeenranta", lat: 61.0587, lon: 28.1887 },
  { id: "kokkola", name: "Kokkola", lat: 63.8385, lon: 23.1307 },
];

const ROUTES = [
  ["helsinki", "turku", 1.8],
  ["helsinki", "tampere", 2.3],
  ["helsinki", "pori", 1.2],
  ["helsinki", "vaasa", 1.4],
  ["helsinki", "jyvaskyla", 2.5],
  ["helsinki", "kuopio", 1.7],
  ["helsinki", "joensuu", 1.4],
  ["helsinki", "oulu", 1.7],
  ["helsinki", "lahti", 1.1],
  ["helsinki", "mikkeli", 1.2],
  ["helsinki", "lappeenranta", 1.1],
  ["turku", "tampere", 1.2],
  ["tampere", "vaasa", 1.35],
  ["tampere", "jyvaskyla", 1.6],
  ["tampere", "pori", 1],
  ["vaasa", "kokkola", 1],
  ["kokkola", "oulu", 1.05],
  ["jyvaskyla", "kuopio", 1.45],
  ["kuopio", "joensuu", 1.4],
  ["jyvaskyla", "oulu", 1.05],
  ["oulu", "rovaniemi", 1.25],
  ["mikkeli", "kuopio", 1],
  ["lahti", "tampere", 1],
  ["lappeenranta", "joensuu", 0.95],
];

const ROUTE_DEGREE = Object.fromEntries(
  CITY_DATA.map((city) => [
    city.id,
    ROUTES.filter(([from, to]) => from === city.id || to === city.id).length,
  ]),
);

const FINLAND_OUTLINE = [
  [19.6, 60.0], [20.6, 60.05], [21.25, 60.38], [22.35, 59.75],
  [23.35, 59.72], [24.15, 59.83], [25.15, 59.72], [26.0, 60.05],
  [27.4, 60.12], [28.3, 60.0], [29.35, 60.3], [30.15, 60.65],
  [31.55, 61.3], [31.42, 62.0], [30.55, 62.55], [30.5, 63.18],
  [31.05, 64.1], [30.85, 64.9], [30.2, 65.45], [30.55, 66.3],
  [30.05, 67.0], [29.38, 67.6], [29.75, 68.2], [29.15, 68.8],
  [28.5, 69.05], [27.7, 69.8], [26.75, 69.62], [26.2, 70.05],
  [25.45, 69.96], [25.0, 69.53], [24.3, 69.42], [23.56, 68.92],
  [23.45, 68.35], [24.05, 67.67], [23.7, 66.95], [23.15, 66.4],
  [23.45, 65.88], [22.7, 65.38], [22.1, 64.9], [21.86, 64.23],
  [21.3, 63.55], [21.42, 62.85], [20.75, 62.58], [20.5, 61.78],
  [20.14, 61.1], [19.82, 60.72],
];

const EXTRA_GEO_NODES = [
  [21.1, 61.0], [22.05, 62.35], [24.45, 63.2], [25.15, 64.0],
  [26.1, 64.5], [27.2, 65.7], [28.1, 66.0], [29.2, 64.5],
  [26.45, 61.2], [23.0, 62.4], [28.9, 61.5], [24.5, 60.4],
];

const DEFAULT_STATUS = {
  connected: false,
  mode: "loading",
  message: "Loading dispatch data",
  activeWorld: null,
};

const formatEuro = (value, digits = 0) =>
  new Intl.NumberFormat("en-FI", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);

const formatNumber = (value) => new Intl.NumberFormat("en-US").format(value ?? 0);

function Icon({ name, size = 16, strokeWidth = 1.7 }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  const paths = {
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    chart: <><path d="M4 19V5" /><path d="M4 19h17" /><path d="m7 14 4-4 3 2 5-6" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
    chevron: <><path d="m9 18 6-6-6-6" /></>,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    crosshair: <><circle cx="12" cy="12" r="7.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /><circle cx="12" cy="12" r="1.5" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><path d="M12 14v3" /></>,
    play: <><path d="m8 5 12 7-12 7z" fill="currentColor" stroke="none" /></>,
    pulse: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
    route: <><circle cx="6" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M8 18h2a4 4 0 0 0 4-4v-4a4 4 0 0 1 4-4" /></>,
    sliders: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
    spark: <><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
    truck: <><path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z" /><circle cx="7.5" cy="18" r="1.8" /><circle cx="18" cy="18" r="1.8" /></>,
    wallet: <><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 9h18M16 14h2" /></>,
  };
  return <svg {...common}>{paths[name] ?? paths.spark}</svg>;
}

function project(lon, lat) {
  return {
    x: 270 + (lon - 25.5) * 26,
    y: ((70.35 - lat) / 10.9) * 620 + 10,
  };
}

function getMapCities(remoteMap) {
  return CITY_DATA.map((city) => {
    const remote = remoteMap?.places?.find(
      (place) =>
        place.id?.toLowerCase() === city.id ||
        place.name?.toLowerCase() === city.name.toLowerCase(),
    );
    return {
      ...city,
      corridors: ROUTE_DEGREE[city.id] ?? 0,
      ...(remote ? { lat: remote.lat, lon: remote.lon } : {}),
    };
  });
}

function RouteMap({ remoteMap, selectedCity, activeTab, onSelectCity }) {
  const cities = useMemo(() => getMapCities(remoteMap), [remoteMap]);
  const cityById = useMemo(() => Object.fromEntries(cities.map((city) => [city.id, city])), [cities]);
  const outlinePath = useMemo(
    () =>
      `${FINLAND_OUTLINE.map(([lon, lat], index) => {
        const point = project(lon, lat);
        return `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
      }).join(" ")} Z`,
    [],
  );

  return (
    <svg
      className="finland-map"
      viewBox="0 0 540 640"
      role="img"
      aria-label="RoutePulse delivery network across Finland"
    >
      <defs>
        <linearGradient id="landFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#23231f" />
          <stop offset="1" stopColor="#191a17" />
        </linearGradient>
        <radialGradient id="landGlow" cx="50%" cy="57%" r="58%">
          <stop offset="0" stopColor="#c6582b" stopOpacity=".12" />
          <stop offset="1" stopColor="#c6582b" stopOpacity="0" />
        </radialGradient>
        <filter id="routeGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <clipPath id="finlandClip"><path d={outlinePath} /></clipPath>
      </defs>

      <path className="land-shadow" d={outlinePath} transform="translate(0 8)" />
      <path className="land-silhouette" d={outlinePath} fill="url(#landFill)" />
      <path className="land-highlight" d={outlinePath} fill="url(#landGlow)" />
      <g className="map-grain" clipPath="url(#finlandClip)">
        <path d="M80 610 460 105M30 475 430 20M60 300 520 550" />
        <path d="M10 180h510M8 345h510M10 520h510" />
      </g>

      <g className={`route-lines route-layer-${activeTab.toLowerCase()}`}>
        {ROUTES.map(([fromId, toId, weight], index) => {
          const from = cityById[fromId];
          const to = cityById[toId];
          if (!from || !to) return null;
          const a = project(from.lon, from.lat);
          const b = project(to.lon, to.lat);
          const isActive = selectedCity === fromId || selectedCity === toId;
          return (
            <g key={`${fromId}-${toId}`}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={`route-track ${isActive ? "route-track-active" : ""}`}
                style={{ "--route-delay": `${index * -0.19}s`, "--route-weight": weight }}
              />
              {isActive && (
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="route-glow" filter="url(#routeGlow)" />
              )}
            </g>
          );
        })}
      </g>

      <g className="quiet-nodes" aria-hidden="true">
        {EXTRA_GEO_NODES.map(([lon, lat], index) => {
          const point = project(lon, lat);
          return <circle key={index} cx={point.x} cy={point.y} r="2.35" />;
        })}
      </g>

      <g className="city-nodes">
        {cities.map((city, index) => {
          const point = project(city.lon, city.lat);
          const selected = selectedCity === city.id;
          const center = city.id === "helsinki";
          const radius = 2.7 + city.corridors * 0.55;
          const labelOffset = city.label === "left" ? -12 : city.label === "below" ? 0 : 13;
          const textAnchor = city.label === "left" ? "end" : city.label === "below" ? "middle" : "start";
          const labelY = city.label === "below" ? 24 : 5;
          return (
            <g
              className={`city-marker ${selected ? "city-marker-selected" : ""}`}
              key={city.id}
              onClick={() => onSelectCity(city.id)}
              onKeyDown={(event) => event.key === "Enter" && onSelectCity(city.id)}
              role="button"
              tabIndex="0"
              aria-label={`${city.name}, ${city.corridors} mapped corridors`}
              style={{ "--marker-delay": `${index * 80}ms` }}
            >
              {(center || selected) && <circle className="node-pulse" cx={point.x} cy={point.y} r={radius + 6} />}
              <circle className="node-halo" cx={point.x} cy={point.y} r={radius + 2.3} />
              <circle className="node-core" cx={point.x} cy={point.y} r={radius} />
              {city.label && (
                <text
                  className={`city-label ${selected ? "city-label-selected" : ""}`}
                  x={point.x + labelOffset}
                  y={point.y + labelY}
                  textAnchor={textAnchor}
                >
                  {city.name}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function MiniTrend({ values = [] }) {
  const points = values.length ? values : [8, 12, 11, 17, 14, 24, 28];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = Math.max(1, max - min);
  const path = points
    .map((value, index) => {
      const x = 2 + (index / Math.max(1, points.length - 1)) * 116;
      const y = 31 - ((value - min) / range) * 24;
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
  return (
    <svg className="mini-trend" viewBox="0 0 120 36" aria-hidden="true">
      <path d={`${path} L118 34 L2 34 Z`} className="mini-trend-area" />
      <path d={path} className="mini-trend-line" />
    </svg>
  );
}

function MarginChart({ days = [] }) {
  const values = days.map((day) => Number(day.margin) || 0);
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => ({
    x: 12 + index * (276 / Math.max(1, values.length - 1)),
    y: 111 - (value / max) * 87,
    day: days[index],
  }));
  const path = points.map(({ x, y }, index) => `${index ? "L" : "M"}${x} ${y}`).join(" ");
  const area = points.length
    ? `${path} L${points.at(-1).x} 118 L${points[0].x} 118 Z`
    : "";
  return (
    <div className="chart-wrap">
      <svg className="margin-chart" viewBox="0 0 300 140" role="img" aria-label="Cumulative margin through the run">
        <defs>
          <linearGradient id="chartArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ee7544" stopOpacity=".23" />
            <stop offset="1" stopColor="#ee7544" stopOpacity="0" />
          </linearGradient>
          <filter id="chartGlow" x="-30%" y="-100%" width="160%" height="300%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {[27, 57, 87, 117].map((y) => <line key={y} x1="8" x2="294" y1={y} y2={y} className="chart-grid" />)}
        {area && <path d={area} className="chart-area" />}
        {path && <path d={path} className="chart-line" filter="url(#chartGlow)" />}
        {points.map((point, index) => (
          <circle key={index} cx={point.x} cy={point.y} r={index === points.length - 1 ? 3.6 : 2.2} className="chart-dot">
            <title>{`${point.day?.day ?? ""}: ${formatEuro(point.day?.margin ?? 0, 0)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="chart-labels">
        {(days.length ? days : []).map((day, index) => (
          <span key={`${day.day}-${index}`}>{day.day?.slice(0, 3)}</span>
        ))}
      </div>
    </div>
  );
}

function StatCard({ eyebrow, value, detail, icon, accent = false, trend }) {
  return (
    <article className={`stat-card ${accent ? "stat-card-accent" : ""}`}>
      <div className="stat-card-top">
        <span>{eyebrow}</span>
        <span className="stat-icon"><Icon name={icon} size={15} /></span>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-card-bottom">
        <span>{detail}</span>
        {trend && <MiniTrend values={trend} />}
      </div>
    </article>
  );
}

function App() {
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [result, setResult] = useState(null);
  const [remoteMap, setRemoteMap] = useState(null);
  const [selectedCity, setSelectedCity] = useState("helsinki");
  const [formula, setFormula] = useState(INITIAL_FORMULA);
  const [seed, setSeed] = useState("routepulse-ui");
  const [simulation, setSimulation] = useState("idle");
  const [simulationMessage, setSimulationMessage] = useState("");
  const [taskId, setTaskId] = useState(null);
  const [activeTab, setActiveTab] = useState("Network");
  const replayToken = useRef(0);

  useEffect(() => {
    let active = true;
    fetch("/api/dashboard")
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        setStatus(payload.status ?? DEFAULT_STATUS);
        setResult(payload.result ?? null);
        setRemoteMap(payload.map ?? null);
      })
      .catch(() => {
        if (!active) return;
        setStatus({
          connected: false,
          mode: "offline",
          message: "Dashboard server is offline",
          activeWorld: null,
        });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!taskId) return undefined;
    let cancelled = false;
    let timeout;
    const poll = async () => {
      try {
        const response = await fetch(`/api/simulate/${encodeURIComponent(taskId)}`);
        const payload = await response.json();
        if (cancelled) return;
        if (payload.result) setResult(payload.result);
        if (payload.status === "running") {
          setSimulation("running");
          setSimulationMessage(payload.message || "Walking the route network…");
          timeout = window.setTimeout(poll, 850);
        } else {
          setTaskId(null);
          setSimulation(payload.status === "complete" ? "complete" : "failed");
          setSimulationMessage(payload.message || payload.sourceFile || payload.logFile || "Simulation finished");
          if (payload.status === "complete") {
            setStatus((current) => ({
              ...current,
              connected: true,
              mode: "live",
              message: "Simulation complete",
            }));
          }
        }
      } catch {
        if (!cancelled) {
          setTaskId(null);
          setSimulation("failed");
          setSimulationMessage("Could not read simulation status");
        }
      }
    };
    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [taskId]);

  const currentCity = useMemo(
    () => CITY_DATA.find((city) => city.id === selectedCity) ?? CITY_DATA[0],
    [selectedCity],
  );

  const formulaTotals = useMemo(() => {
    const effective =
      formula.driverFee +
      formula.returnCost +
      formula.lateRisk -
      formula.synergy +
      formula.capacity;
    const contribution = formula.quote - effective;
    return {
      effective,
      contribution,
      rate: formula.quote > 0 ? (contribution / formula.quote) * 100 : 0,
    };
  }, [formula]);

  const isBusy = ["preparing", "running", "replay"].includes(simulation);
  const days = result?.days ?? [];
  const dailyTrend = days.map((day) => Number(day.margin) || 0);
  const activeWorld = status.activeWorld;
  const liveScore = activeWorld?.snapshot;
  const displayMargin = liveScore?.margin ?? result?.margin ?? 0;
  const displayRevenue = liveScore?.revenue ?? result?.revenue ?? 0;
  const displayOrders = liveScore?.orders ?? result?.orders ?? 0;
  const displayOnTime = liveScore?.onTime ?? result?.onTime ?? 0;
  const marginShare = liveScore?.marginShare ?? result?.marginShare ?? 0;
  const undelivered = liveScore?.notDelivered ?? result?.notDelivered ?? 0;

  const updateFormula = (key, value) =>
    setFormula((current) => ({ ...current, [key]: Number(value) }));

  const replayResult = async (savedResult, message) => {
    const token = ++replayToken.current;
    const replayDays = savedResult?.days ?? [];
    setSimulation("replay");
    setSimulationMessage(message || "Replaying a saved Level 8 run");
    for (let index = 0; index < replayDays.length; index += 1) {
      if (token !== replayToken.current) return;
      const day = replayDays[index];
      setResult({
        ...savedResult,
        margin: day.margin,
        revenue: day.revenue,
        orders: day.orders,
        onTime: day.onTime,
        notDelivered: day.notDelivered,
        days: replayDays.slice(0, index + 1),
      });
      await new Promise((resolve) => window.setTimeout(resolve, 440));
    }
    if (token === replayToken.current) {
      setResult(savedResult);
      setSimulation("complete");
      setSimulationMessage(`Replay complete · ${message || savedResult?.source || "saved results"}`);
    }
  };

  const runSimulation = async () => {
    if (isBusy) return;
    replayToken.current += 1;
    setSimulation("preparing");
    setSimulationMessage("Checking the dispatch connection…");
    try {
      const response = await fetch("/api/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed: seed.trim() || "routepulse-ui" }),
      });
      const payload = await response.json();
      if (payload.mode === "replay" && payload.result) {
        const replayStatus = payload.status ?? {};
        setStatus((current) => ({
          ...current,
          ...replayStatus,
          connected: replayStatus.connected ?? current.connected,
          mode: replayStatus.mode ?? "replay",
          message: replayStatus.message ?? payload.message ?? "Using saved result data",
          activeWorld: Object.hasOwn(replayStatus, "activeWorld")
            ? replayStatus.activeWorld
            : current.activeWorld,
        }));
        await replayResult(payload.result, payload.message);
      } else if (payload.taskId) {
        setTaskId(payload.taskId);
        setSimulation("running");
        setSimulationMessage("Level 8 is moving through the network…");
      } else {
        setSimulation("failed");
        setSimulationMessage(payload.message || "Simulation could not start");
      }
    } catch {
      setSimulation("failed");
      setSimulationMessage("API server unavailable. Reload after starting the dashboard server.");
    }
  };

  const resetToSaved = async () => {
    replayToken.current += 1;
    setTaskId(null);
    setSimulation("idle");
    try {
      const response = await fetch("/api/dashboard");
      const payload = await response.json();
      setResult(payload.result ?? result);
      setStatus(payload.status ?? DEFAULT_STATUS);
      setRemoteMap(payload.map ?? null);
    } catch {
      // Keep the last visible run if the dashboard server is offline.
    }
  };

  const tabs = ["Network", "Economics", "Reliability"];
  const sourceLabel = result?.sourceFile
    ? result.sourceFile.replace(/^results\//, "")
    : result?.source || "Saved Level 8 run";

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="background-grain" />

      <header className="topbar">
        <a className="brand" href="#overview" aria-label="RoutePulse home">
          <span className="brand-mark"><Icon name="route" size={18} strokeWidth={1.6} /></span>
          <span className="brand-word">route<span>pulse</span></span>
          <span className="brand-divider" />
          <span className="brand-caption">Dispatch intelligence</span>
        </a>
        <div className="topbar-center">
          <span className="topbar-overline">FINLAND NETWORK</span>
          <span className="topbar-separator" />
          <span className="topbar-level">LEVEL <b>08</b></span>
        </div>
        <div className="topbar-status">
          <span className={`status-led ${status.connected ? "status-led-live" : ""}`} />
          <span className="status-label">{status.connected ? "TEAM CONNECTED" : "LOCAL REPLAY"}</span>
          <button className="icon-button" type="button" aria-label="Refresh dashboard" onClick={resetToSaved}>
            <Icon name="crosshair" size={17} />
          </button>
        </div>
      </header>

      <main id="overview" className="dashboard">
        <section className="intro-row">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" />AUTONOMOUS PRICING & DISPATCH</div>
            <h1>Every route.<br /><span>One clear picture.</span></h1>
            <p className="intro-copy">
              A live view of the decisions shaping margin, delivery speed, and driver supply across Finland.
            </p>
          </div>
          <div className="intro-action">
            <div className="run-meta">
              <span className="run-meta-label">SIMULATION SEED</span>
              <label className="seed-input-wrap">
                <span className="seed-prefix">#</span>
                <input
                  value={seed}
                  maxLength={48}
                  onChange={(event) => setSeed(event.target.value.replace(/[^a-zA-Z0-9._-]/g, ""))}
                  aria-label="Simulation seed"
                  disabled={isBusy}
                />
              </label>
            </div>
            <button className="simulate-button" type="button" onClick={runSimulation} disabled={isBusy}>
              <span className="simulate-icon">{isBusy ? <span className="button-spinner" /> : <Icon name="play" size={12} />}</span>
              <span>{isBusy ? "RUNNING SIMULATION" : "SIMULATE A RUN"}</span>
              {!isBusy && <Icon name="arrow" size={15} />}
            </button>
            <div className={`simulation-note ${simulation === "failed" ? "simulation-note-error" : ""}`} aria-live="polite">
              <span className="note-dot" />
              {simulationMessage || status.message}
            </div>
          </div>
        </section>

        <div className="main-grid">
          <aside className="left-column">
            <section className="panel overview-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow-small">RUN OVERVIEW</span>
                  <h2>
                    {activeWorld
                      ? `Level ${activeWorld.level} · active world`
                      : simulation === "running"
                        ? "Level 08 · live simulation"
                        : "Saved Level 8 run"}
                  </h2>
                </div>
                <span className="panel-menu" aria-hidden="true">•••</span>
              </div>

              <div className="hero-metric">
                <div className="metric-caption"><span className="metric-dot" />GROSS MARGIN</div>
                <div className="hero-metric-value">{formatEuro(displayMargin, 2)}</div>
                <div className="metric-change">
                  <span className="change-pill"><Icon name="check" size={12} /> LEVEL 08</span>
                  <span>{activeWorld ? "live world" : "saved ranking run"}</span>
                </div>
                <MiniTrend values={dailyTrend} />
              </div>

              <div className="overview-stats">
                <div className="overview-stat">
                  <span className="stat-icon-box"><Icon name="wallet" size={15} /></span>
                  <span className="overview-stat-name">Revenue</span>
                  <b>{formatEuro(displayRevenue, 0)}</b>
                </div>
                <div className="overview-stat">
                  <span className="stat-icon-box"><Icon name="truck" size={15} /></span>
                  <span className="overview-stat-name">Orders won</span>
                  <b>{formatNumber(displayOrders)}</b>
                </div>
                <div className="overview-stat">
                  <span className="stat-icon-box"><Icon name="pulse" size={15} /></span>
                  <span className="overview-stat-name">On-time</span>
                  <b>{Number(displayOnTime).toFixed(1)}<small>%</small></b>
                </div>
              </div>
              <div className="margin-share-row">
                <div>
                  <span>Margin share</span>
                  <b>{Number(marginShare).toFixed(1)}%</b>
                </div>
                <div className="share-meter"><span style={{ width: `${Math.min(100, Math.max(0, marginShare))}%` }} /></div>
              </div>
            </section>

            <section className="panel pulse-panel">
              <div className="panel-heading panel-heading-compact">
                <div>
                  <span className="eyebrow-small">NETWORK PULSE</span>
                  <h2>Healthy flow</h2>
                </div>
                <span className="live-tag"><span />{activeWorld ? "LIVE" : "SAVED"}</span>
              </div>
              <div className="pulse-score">
                <div className="pulse-ring" style={{ "--score-angle": `${Math.max(0, Math.min(100, displayOnTime)) / 100}turn` }}>
                  <span>{Number(displayOnTime).toFixed(0)}<small>%</small></span>
                </div>
                <div>
                  <div className="pulse-title">On-time deliveries</div>
                  <div className="pulse-subtitle">{Number(undelivered).toFixed(1)}% undelivered in this run</div>
                </div>
              </div>
              <div className="pulse-foot">
                <span><i className="tiny-led" />{ROUTES.length} corridors visualized</span>
                <span>Level 08</span>
              </div>
            </section>

            <div className="source-footnote">
              <Icon name="lock" size={13} />
              <span>
                {status.connected
                  ? "Team key stays on this server · chart from saved result"
                  : `Saved data · ${sourceLabel}`}
              </span>
            </div>
          </aside>

          <section className="map-column">
            <div className="map-panel">
              <div className="map-heading">
                <div>
                  <span className="eyebrow-small">ROUTE TOPOLOGY</span>
                  <h2>Finland <span className="map-heading-muted">/ Northern Europe</span></h2>
                </div>
                <div className="map-tabs" role="tablist" aria-label="Map data layer">
                  {tabs.map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === tab}
                      className={activeTab === tab ? "map-tab map-tab-active" : "map-tab"}
                      onClick={() => setActiveTab(tab)}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
              </div>

              <div className="map-canvas">
                <div className="map-scanline" />
                <div className="map-coordinate coordinate-nw">66°30′N&nbsp; 25°43′E</div>
                <div className="map-coordinate coordinate-se">60°10′N&nbsp; 24°56′E</div>
                <RouteMap
                  remoteMap={remoteMap}
                  selectedCity={selectedCity}
                  activeTab={activeTab}
                  onSelectCity={setSelectedCity}
                />
                <div className="map-north" aria-hidden="true"><span>N</span><i /></div>
                <div className="map-legend">
                  <span><i className="legend-line" />Optimized corridor</span>
                  <span><i className="legend-node" />Active hub</span>
                </div>
                <div className="map-selected-card">
                  <span className="selected-card-icon"><Icon name="route" size={15} /></span>
                  <div>
                  <span className="selected-card-overline">MAPPED CORRIDORS</span>
                  <b>{currentCity?.name}</b>
                </div>
                <span className="selected-card-count">{ROUTE_DEGREE[currentCity?.id] ?? 0}<small> routes</small></span>
                </div>
                <div className="map-scale"><span />250 km</div>
                <div className="map-caption">ROUTEPULSE NETWORK <span>·</span> 14 HUBS <span>·</span> 24 CORRIDORS</div>
              </div>
            </div>

            <div className="map-bottom-row">
              <div className="map-bottom-copy">
                <span className="eyebrow-small">{activeTab.toUpperCase()} LAYER</span>
                <p>
                  {activeTab === "Network"
                    ? "Corridors connect dense southern hubs with high-value northern routes."
                    : activeTab === "Economics"
                      ? "Routes are weighted by expected fee, return flow, and delivery risk."
                      : "Driver availability and deadline slack guide every dispatch decision."}
                </p>
              </div>
              <button className="text-button" type="button" onClick={() => setSelectedCity("helsinki")}>
                Reset view <Icon name="crosshair" size={14} />
              </button>
            </div>
          </section>

          <aside className="right-column">
            <section className="panel performance-panel">
              <div className="panel-heading panel-heading-compact">
                <div>
                  <span className="eyebrow-small">PERFORMANCE</span>
                  <h2>Margin trajectory</h2>
                </div>
                <button className="chart-menu" type="button" aria-label="Performance chart details">•••</button>
              </div>
              <div className="chart-key">
                <span><i />Cumulative margin</span>
                <span className="chart-period">7-DAY RUN</span>
              </div>
              <MarginChart days={days} />
              <div className="chart-total">
                <div><span>Run total</span><b>{formatEuro(displayMargin, 0)}</b></div>
                <span className="chart-growth">+{Number(marginShare).toFixed(1)}% margin share</span>
              </div>
            </section>

            <section className="panel economics-panel">
              <div className="panel-heading panel-heading-compact">
                <div>
                  <span className="eyebrow-small">MARGIN ENGINE</span>
                  <h2>One order, unpacked</h2>
                </div>
                <span className="formula-badge"><Icon name="spark" size={13} /></span>
              </div>
              <p className="economics-intro">Illustrative order economics. Adjust this quote and cost mix to recalculate contribution.</p>

              <label className="quote-control">
                <span>Quoted price <b>{formatEuro(formula.quote)}</b></span>
                <input
                  type="range"
                  min="350"
                  max="1400"
                  step="10"
                  value={formula.quote}
                  onChange={(event) => updateFormula("quote", event.target.value)}
                  aria-label="Quoted price"
                />
                <span className="range-ends"><small>€350</small><small>€1,400</small></span>
              </label>

              <div className="cost-breakdown">
                <div className="cost-row">
                  <span><i className="cost-mark cost-mark-orange" />Expected driver fee</span>
                  <label><span>−</span><input aria-label="Expected driver fee" type="number" min="0" value={formula.driverFee} onChange={(event) => updateFormula("driverFee", event.target.value)} /></label>
                </div>
                <div className="cost-row">
                  <span><i className="cost-mark cost-mark-muted" />Return-flow cost</span>
                  <label><span>−</span><input aria-label="Return-flow cost" type="number" min="0" value={formula.returnCost} onChange={(event) => updateFormula("returnCost", event.target.value)} /></label>
                </div>
                <div className="cost-row">
                  <span><i className="cost-mark cost-mark-red" />Late-risk exposure</span>
                  <label><span>−</span><input aria-label="Late-risk exposure" type="number" min="0" value={formula.lateRisk} onChange={(event) => updateFormula("lateRisk", event.target.value)} /></label>
                </div>
                <div className="cost-row">
                  <span><i className="cost-mark cost-mark-green" />Bundle synergy credit</span>
                  <label className="credit-value"><span>+</span><input aria-label="Bundle synergy credit" type="number" min="0" value={formula.synergy} onChange={(event) => updateFormula("synergy", event.target.value)} /></label>
                </div>
                <div className="cost-row">
                  <span><i className="cost-mark cost-mark-violet" />Capacity shadow cost</span>
                  <label><span>−</span><input aria-label="Capacity shadow cost" type="number" min="0" value={formula.capacity} onChange={(event) => updateFormula("capacity", event.target.value)} /></label>
                </div>
              </div>

              <div className="effective-cost-row">
                <span>Effective cost</span>
                <b>{formatEuro(formulaTotals.effective)}</b>
              </div>
              <div className="contribution-card">
                <div>
                  <span>EXPECTED CONTRIBUTION</span>
                  <b className={formulaTotals.contribution < 0 ? "negative-value" : ""}>{formatEuro(formulaTotals.contribution)}</b>
                </div>
                <span className="contribution-share">{formulaTotals.rate.toFixed(1)}%</span>
              </div>
              <div className="formula-footnote">
                <Icon name="spark" size={13} />
                <span>Quote − (fee + return + risk − synergy + capacity)</span>
              </div>
            </section>
          </aside>
        </div>

        <section className="bottom-strip">
          <div className="strip-item strip-item-title">
            <span className="strip-icon"><Icon name="spark" size={15} /></span>
            <div><span className="eyebrow-small">DECISION PRINCIPLE</span><b>Price the route, not just the distance.</b></div>
          </div>
          <div className="strip-item"><span className="strip-value">22–32<span>m</span></span><span>Corridor pairing window</span></div>
          <div className="strip-item"><span className="strip-value">0.81<span>×</span></span><span>Opening fee vs typical</span></div>
          <div className="strip-item"><span className="strip-value">07:05<span>–</span>22:45</span><span>Driver notification window</span></div>
          <div className="strip-status">
            <span className={`status-led ${status.connected ? "status-led-live" : ""}`} />
            <span>{status.connected ? "Spread API reachable" : "Saved-run fallback ready"}</span>
          </div>
        </section>

        <footer className="footer">
          <span>ROUTEPULSE <i>©</i> 2026</span>
          <span>{activeWorld ? `LIVE WORLD · ${activeWorld.worldId}` : `DATA SOURCE · ${sourceLabel}`}</span>
          <span className="footer-secure"><Icon name="lock" size={12} />TEAM KEY NEVER REACHES THE BROWSER</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
