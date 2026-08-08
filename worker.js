import { sendTelegram } from "./telegram.js";

// ============================================================
// ☀️ SOL RADAR — AUTONOMOUS PAPER TRADING BOT
// ============================================================

const CONFIG = {
  SYMBOL: "SOL",
  MIN_SCORE: 72,
  MAX_OPEN_TRADES: 3,
  SIGNAL_COOLDOWN_MINUTES: 15,
  STARTING_BALANCE: 1000,
  RISK_PER_TRADE: 0.01
};

// ============================================================
// WORKER
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      // Telegram webhook
      if (
        url.pathname === "/telegram" &&
        request.method === "POST"
      ) {
        return await handleTelegram(request, env);
      }

      // Health check
      if (url.pathname === "/") {
        return json({
          bot: "SOL RADAR",
          status: "online",
          mode: "PAPER TRADING",
          version: "1.1"
        });
      }

      // Status endpoint
      if (url.pathname === "/status") {
        const state = await getState(env);

        return json({
          bot: "SOL RADAR",
          active: state.active,
          signals: state.signals.length,
          openTrades: state.openTrades.length,
          closedTrades: state.closedTrades.length,
          balance: state.balance
        });
      }

      return json({
        error: "Not found"
      }, 404);

    } catch (error) {
      console.error(error);

      return json({
        error: error.message
      }, 500);
    }
  },

  // ==========================================================
  // AUTONOMOUS CRON
  // ==========================================================

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRadar(env));
  }
};

// ============================================================
// RADAR
// ============================================================

async function runRadar(env) {
  const state = await getState(env);

  if (!state.active) {
    console.log("SOL RADAR OFF");
    return;
  }

  try {
    const market = await getMarketData();

    if (!market) {
      return;
    }

    await updateOpenTrades(state, market);

    if (
      state.openTrades.length >=
      CONFIG.MAX_OPEN_TRADES
    ) {
      await saveState(env, state);
      return;
    }

    if (!cooldownPassed(state)) {
      await saveState(env, state);
      return;
    }

    const signal =
      generateSignal(market);

    if (!signal) {
      state.lastScan = Date.now();
      await saveState(env, state);
      return;
    }

    const trade =
      createPaperTrade(signal);

    state.openTrades.push(trade);
    state.signals.push(signal);

    state.lastSignal = signal;
    state.lastScan = Date.now();

    await saveState(env, state);

    // Telegram chat automatically learned from /start
    if (state.chatId) {
      await sendTelegram(
        env,
        state.chatId,
        formatSignal(signal)
      );
    }

  } catch (error) {
    console.error(
      "RADAR ERROR:",
      error
    );
  }
}

// ============================================================
// MARKET DATA
// ============================================================

async function getMarketData() {
  const response = await fetch(
    "https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=1&interval=5m"
  );

  if (!response.ok) {
    throw new Error(
      "Market API unavailable"
    );
  }

  const data =
    await response.json();

  const prices =
    data.prices || [];

  const volumes =
    data.total_volumes || [];

  if (prices.length < 30) {
    return null;
  }

  const candles = [];

  for (
    let i = 0;
    i < prices.length;
    i++
  ) {
    candles.push({
      time: prices[i][0],
      price: Number(prices[i][1]),
      volume:
        volumes[i]
          ? Number(volumes[i][1])
          : 0
    });
  }

  return {
    candles,
    price:
      candles[candles.length - 1]
        .price
  };
}

// ============================================================
// SIGNAL ENGINE
// ============================================================

function generateSignal(market) {
  const candles =
    market.candles;

  if (candles.length < 30) {
    return null;
  }

  const closes =
    candles.map(
      c => c.price
    );

  const volumes =
    candles.map(
      c => c.volume
    );

  const price =
    closes[closes.length - 1];

  // Fast / slow trend
  const fastMA =
    average(
      closes.slice(-9)
    );

  const slowMA =
    average(
      closes.slice(-21)
    );

  const bullishTrend =
    fastMA > slowMA;

  const bearishTrend =
    fastMA < slowMA;

  // Momentum
  const momentum =
    (
      (price -
        closes[closes.length - 6]) /
      closes[closes.length - 6]
    ) * 100;

  // Volume
  const recentVolume =
    average(
      volumes.slice(-5)
    );

  const oldVolume =
    average(
      volumes.slice(-20)
    );

  const volumeRatio =
    oldVolume > 0
      ? recentVolume / oldVolume
      : 1;

  // Recent range
  const recentPrices =
    closes.slice(-20);

  const high =
    Math.max(
      ...recentPrices
    );

  const low =
    Math.min(
      ...recentPrices
    );

  const rangePercent =
    ((high - low) / low) *
    100;

  // Breakout
  const previousHigh =
    Math.max(
      ...closes.slice(-12, -1)
    );

  const previousLow =
    Math.min(
      ...closes.slice(-12, -1)
    );

  const bullishBreakout =
    price > previousHigh;

  const bearishBreakout =
    price < previousLow;

  // Scores
  let longScore = 0;
  let shortScore = 0;

  if (bullishTrend) {
    longScore += 25;
  }

  if (bearishTrend) {
    shortScore += 25;
  }

  if (bullishBreakout) {
    longScore += 25;
  }

  if (bearishBreakout) {
    shortScore += 25;
  }

  if (momentum > 0.35) {
    longScore += 20;
  }

  if (momentum < -0.35) {
    shortScore += 20;
  }

  if (volumeRatio > 1.25) {
    if (bullishTrend) {
      longScore += 15;
    }

    if (bearishTrend) {
      shortScore += 15;
    }
  }

  if (rangePercent > 1) {
    if (bullishTrend) {
      longScore += 10;
    }

    if (bearishTrend) {
      shortScore += 10;
    }
  }

  const score =
    Math.max(
      longScore,
      shortScore
    );

  if (
    score <
    CONFIG.MIN_SCORE
  ) {
    return null;
  }

  const side =
    longScore > shortScore
      ? "LONG"
      : "SHORT";

  // Risk model
  const volatility =
    Math.max(
      rangePercent / 100,
      0.005
    );

  const stopDistance =
    price *
    volatility *
    0.65;

  const entry =
    price;

  const stop =
    side === "LONG"
      ? entry - stopDistance
      : entry + stopDistance;

  const tp1 =
    side === "LONG"
      ? entry +
        stopDistance * 1.25
      : entry -
        stopDistance * 1.25;

  const tp2 =
    side === "LONG"
      ? entry +
        stopDistance * 2.2
      : entry -
        stopDistance * 2.2;

  return {
    id: crypto.randomUUID(),

    symbol: CONFIG.SYMBOL,
    side,
    score,

    entry,
    stop,
    tp1,
    tp2,

    trend:
      bullishTrend
        ? "BULLISH"
        : "BEARISH",

    breakout:
      bullishBreakout
        ? "UP"
        : bearishBreakout
          ? "DOWN"
          : "NONE",

    momentum,
    volumeRatio,
    rangePercent,

    timestamp:
      Date.now(),

    result: "OPEN"
  };
}

// ============================================================
// PAPER TRADE
// ============================================================

function createPaperTrade(signal) {
  const riskCapital =
    CONFIG.STARTING_BALANCE *
    CONFIG.RISK_PER_TRADE;

  const riskPerUnit =
    Math.abs(
      signal.entry -
      signal.stop
    );

  const quantity =
    riskPerUnit > 0
      ? riskCapital /
        riskPerUnit
      : 0;

  return {
    id: signal.id,

    side: signal.side,

    entry: signal.entry,
    stop: signal.stop,

    tp1: signal.tp1,
    tp2: signal.tp2,

    quantity,

    openedAt:
      Date.now(),

    status: "OPEN"
  };
}

// ============================================================
// TRADE MANAGEMENT
// ============================================================

async function updateOpenTrades(
  state,
  market
) {
  const price =
    market.price;

  for (
    const trade
    of state.openTrades
  ) {
    if (
      trade.status !==
      "OPEN"
    ) {
      continue;
    }

    let outcome = null;
    let exitPrice = null;

    if (
      trade.side ===
      "LONG"
    ) {
      if (
        price <=
        trade.stop
      ) {
        outcome = "LOSS";
        exitPrice =
          trade.stop;
      }

      if (
        price >=
        trade.tp2
      ) {
        outcome = "WIN";
        exitPrice =
          trade.tp2;
      }

    } else {

      if (
        price >=
        trade.stop
      ) {
        outcome = "LOSS";
        exitPrice =
          trade.stop;
      }

      if (
        price <=
        trade.tp2
      ) {
        outcome = "WIN";
        exitPrice =
          trade.tp2;
      }
    }

    if (!outcome) {
      continue;
    }

    const pnl =
      trade.side ===
      "LONG"
        ? (
            exitPrice -
            trade.entry
          ) * trade.quantity
        : (
            trade.entry -
            exitPrice
          ) * trade.quantity;

    trade.status =
      outcome;

    trade.exit =
      exitPrice;

    trade.pnl =
      pnl;

    trade.closedAt =
      Date.now();

    state.closedTrades.push(
      trade
    );

    state.balance +=
      pnl;
  }

  state.openTrades =
    state.openTrades.filter(
      t =>
        t.status ===
        "OPEN"
    );
}

// ============================================================
// TELEGRAM COMMANDS
// ============================================================

async function handleTelegram(
  request,
  env
) {
  const update =
    await request.json();

  if (
    !update.message
  ) {
    return json({
      ok: true
    });
  }

  const chatId =
    update.message.chat.id;

  const text =
    update.message.text ||
    "";

  const command =
    text
      .trim()
      .split(/\s+/)[0]
      .toLowerCase();

  const state =
    await getState(env);

  // Automatically remember your Telegram chat
  state.chatId =
    chatId;

  // ----------------------------------------------------------
  // START
  // ----------------------------------------------------------

  if (
    command ===
    "/start"
  ) {
    state.active =
      true;

    await saveState(
      env,
      state
    );

    await sendTelegram(
      env,
      chatId,
      [
        "☀️ SOL RADAR ACTIVADO 🟢",
        "",
        "Escaneo automático: ON",
        "Modo: PAPER TRADING",
        "Frecuencia: cada 5 minutos",
        "",
        "Usa /stop para apagarlo."
      ].join("\n")
    );

    return json({
      ok: true
    });
  }

  // ----------------------------------------------------------
  // STOP
  // ----------------------------------------------------------

  if (
    command ===
    "/stop"
  ) {
    state.active =
      false;

    await saveState(
      env,
      state
    );

    await sendTelegram(
      env,
      chatId,
      [
        "🛑 SOL RADAR DETENIDO 🔴",
        "",
        "No se generarán nuevas señales.",
        "",
        "Usa /start para activarlo."
      ].join("\n")
    );

    return json({
      ok: true
    });
  }

  // ----------------------------------------------------------
  // STATUS
  // ----------------------------------------------------------

  if (
    command ===
    "/status"
  ) {
    await sendTelegram(
      env,
      chatId,
      formatStatus(state)
    );

    return json({
      ok: true
    });
  }

  // ----------------------------------------------------------
  // STATS
  // ----------------------------------------------------------

  if (
    command ===
    "/stats"
  ) {
    await sendTelegram(
      env,
      chatId,
      formatStats(state)
    );

    return json({
      ok: true
    });
  }

  // ----------------------------------------------------------
  // LAST
  // ----------------------------------------------------------

  if (
    command ===
    "/last"
  ) {
    await sendTelegram(
      env,
      chatId,
      state.lastSignal
        ? formatSignal(
            state.lastSignal
          )
        : "📭 Todavía no hay señales."
    );

    return json({
      ok: true
    });
  }

  // Help
  await sendTelegram(
    env,
    chatId,
    [
      "☀️ SOL RADAR",
      "",
      "/start — activar",
      "/stop — detener",
      "/status — estado",
      "/stats — estadísticas",
      "/last — última señal"
    ].join("\n")
  );

  return json({
    ok: true
  });
}

// ============================================================
// FORMATTING
// ============================================================

function formatSignal(
  signal
) {
  const emoji =
    signal.side ===
    "LONG"
      ? "🟢"
      : "🔴";

  return [
    "☀️ SOL RADAR",
    "━━━━━━━━━━━━━━━━",
    `${emoji} ${signal.side} SIGNAL`,
    "",
    `Score: ${signal.score}/100`,
    "",
    `Entry: $${formatPrice(signal.entry)}`,
    `SL:    $${formatPrice(signal.stop)}`,
    `TP1:   $${formatPrice(signal.tp1)}`,
    `TP2:   $${formatPrice(signal.tp2)}`,
    "",
    `Trend: ${signal.trend}`,
    `Breakout: ${signal.breakout}`,
    `Momentum: ${signal.momentum.toFixed(2)}%`,
    `Volume: ${signal.volumeRatio.toFixed(2)}x`,
    `Range: ${signal.rangePercent.toFixed(2)}%`,
    "",
    "📘 PAPER TRADING",
    `⏱ ${new Date(signal.timestamp).toISOString()}`
  ].join("\n");
}

function formatStatus(
  state
) {
  return [
    "☀️ SOL RADAR STATUS",
    "━━━━━━━━━━━━━━━━",
    `Radar: ${
      state.active
        ? "🟢 ON"
        : "🔴 OFF"
    }`,
    "",
    `Balance: $${state.balance.toFixed(2)}`,
    `Signals: ${state.signals.length}`,
    `Open trades: ${state.openTrades.length}`,
    `Closed trades: ${state.closedTrades.length}`,
    "",
    `Last scan: ${
      state.lastScan
        ? new Date(
            state.lastScan
          ).toLocaleString()
        : "Never"
    }`
  ].join("\n");
}

function formatStats(
  state
) {
  const trades =
    state.closedTrades;

  const wins =
    trades.filter(
      t =>
        t.status ===
        "WIN"
    ).length;

  const losses =
    trades.filter(
      t =>
        t.status ===
        "LOSS"
    ).length;

  const total =
    wins + losses;

  const winRate =
    total > 0
      ? (
          wins /
          total
        ) * 100
      : 0;

  const pnl =
    trades.reduce(
      (sum, t) =>
        sum +
        (t.pnl || 0),
      0
    );

  return [
    "📊 SOL RADAR STATS",
    "━━━━━━━━━━━━━━━━",
    `Trades: ${total}`,
    `Wins: ${wins}`,
    `Losses: ${losses}`,
    `Win rate: ${winRate.toFixed(1)}%`,
    "",
    `P&L: $${pnl.toFixed(2)}`,
    `Balance: $${state.balance.toFixed(2)}`
  ].join("\n");
}

// ============================================================
// STATE
// ============================================================

function defaultState() {
  return {
    active: false,

    balance:
      CONFIG.STARTING_BALANCE,

    signals: [],

    openTrades: [],

    closedTrades: [],

    lastSignal: null,

    lastScan: null,

    chatId: null
  };
}

async function getState(
  env
) {
  if (
    !env.RADAR_STATE
  ) {
    return defaultState();
  }

  const state =
    await env.RADAR_STATE.get(
      "state",
      "json"
    );

  return (
    state ||
    defaultState()
  );
}

async function saveState(
  env,
  state
) {
  if (
    !env.RADAR_STATE
  ) {
    console.warn(
      "RADAR_STATE binding missing"
    );

    return;
  }

  state.signals =
    state.signals.slice(
      -500
    );

  state.closedTrades =
    state.closedTrades.slice(
      -500
    );

  await env.RADAR_STATE.put(
    "state",
    JSON.stringify(
      state
    )
  );
}

// ============================================================
// COOLDOWN
// ============================================================

function cooldownPassed(
  state
) {
  if (
    !state.lastSignal
  ) {
    return true;
  }

  const elapsed =
    Date.now() -
    state.lastSignal
      .timestamp;

  return (
    elapsed >=
    CONFIG.SIGNAL_COOLDOWN_MINUTES *
    60 *
    1000
  );
}

// ============================================================
// HELPERS
// ============================================================

function average(
  values
) {
  if (
    !values.length
  ) {
    return 0;
  }

  return (
    values.reduce(
      (a, b) =>
        a + b,
      0
    ) /
    values.length
  );
}

function formatPrice(
  value
) {
  if (
    value >= 100
  ) {
    return value.toFixed(
      2
    );
  }

  if (
    value >= 1
  ) {
    return value.toFixed(
      3
    );
  }

  return value.toFixed(
    5
  );
}

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "Content-Type":
          "application/json"
      }
    }
  );
}