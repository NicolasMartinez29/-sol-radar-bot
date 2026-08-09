// ☀️ SOL RADAR PULSE V2 — PAPER TRADING ONLY
const PAPER_TRADING_ONLY = true;

const CONFIG = {
  SYMBOL: "SOL",
  PRODUCT_ID: "SOL-USD",

  MIN_SCORE: 72,

  MAX_OPEN_TRADES: 3,
  SIGNAL_COOLDOWN_MINUTES: 15,

  STARTING_BALANCE: 1000,
  RISK_PER_TRADE: 0.01,

  MAX_SCANS: 200,
  MAX_SIGNALS: 500,
  MAX_CLOSED: 500
};

const STAGE_RANK = {
  NORMAL: 0,
  WATCH: 1,
  BUILDING: 2,
  SIGNAL: 3
};

// ============================================================
// WORKER
// ============================================================

export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    try {

      // Telegram webhook
      if (
        url.pathname === "/telegram" &&
        request.method === "POST"
      ) {
        return await handleTelegram(
          request,
          env
        );
      }

      // Health check
      if (url.pathname === "/") {

        return json({
          bot: "SOL RADAR PULSE",
          version: "2.0",
          status: "online",
          mode: "PAPER TRADING"
        });

      }

      // Public status
      if (url.pathname === "/status") {

        const state =
          await getState(env);

        return json(
          publicStatus(state)
        );

      }

      return json(
        {
          error: "Not found"
        },
        404
      );

    } catch (error) {

      console.error(
        "FETCH ERROR",
        safeError(error)
      );

      return json(
        {
          error:
            safeError(error)
        },
        500
      );

    }

  },

  // ==========================================================
  // CRON
  // ==========================================================

  async scheduled(
    event,
    env,
    ctx
  ) {

    ctx.waitUntil(
      runRadar(env)
    );

  }

};

// ============================================================
// RADAR LOOP
// ============================================================

async function runRadar(env) {

  const state =
    await getState(env);

  if (!state.active) {
    return;
  }

  state.lastScan =
    Date.now();

  state.lastError =
    null;

  try {

    const market =
      await getMarketData();

    const analysis =
      analyzeMarket(market);

    const previousStage =
      state.previousStage ||
      "NORMAL";

    // ---------------------------------------------
    // MANAGE EXISTING PAPER TRADES
    // ---------------------------------------------

    const closedNow =
      updateOpenTrades(
        state,
        market.price
      );

    state.lastAnalysis =
      analysis;

    recordScan(
      state,
      analysis
    );

    // ---------------------------------------------
    // TRADE RESULT ALERTS
    // ---------------------------------------------

    for (
      const trade
      of closedNow
    ) {

      if (state.chatId) {

        await sendTelegram(
          env,
          state.chatId,
          formatTradeResult(
            trade,
            state.balance
          )
        );

      }

    }

    // ---------------------------------------------
    // WATCH / BUILDING ALERTS
    // ---------------------------------------------

    const movedUp =
      STAGE_RANK[
        analysis.stage
      ] >
      STAGE_RANK[
        previousStage
      ];

    if (
      movedUp &&
      state.chatId &&
      (
        analysis.stage ===
          "WATCH" ||
        analysis.stage ===
          "BUILDING"
      )
    ) {

      await sendTelegram(
        env,
        state.chatId,
        formatStageAlert(
          analysis
        )
      );

    }

    // ---------------------------------------------
    // SIGNAL
    // ---------------------------------------------

    const enteredSignal =
      analysis.stage ===
        "SIGNAL" &&
      previousStage !==
        "SIGNAL";

    const canOpen =
      enteredSignal &&
      analysis.score >=
        CONFIG.MIN_SCORE &&
      state.openTrades.length <
        CONFIG.MAX_OPEN_TRADES &&
      cooldownPassed(state);

    if (canOpen) {

      const signal =
        buildSignal(
          analysis
        );

      const trade =
        createPaperTrade(
          state,
          signal
        );

      state.openTrades.push(
        trade
      );

      state.signals.push(
        signal
      );

      state.lastSignal =
        signal;

      if (state.chatId) {

        await sendTelegram(
          env,
          state.chatId,
          formatSignal(signal)
        );

      }

    }

    // Always remember current stage.
    // Downward changes happen silently.

    state.previousStage =
      analysis.stage;

    state.lastSuccessfulScan =
      Date.now();

    await saveState(
      env,
      state
    );

  } catch (error) {

    state.lastError =
      safeError(error);

    await saveState(
      env,
      state
    );

    console.error(
      "RADAR ERROR",
      state.lastError
    );

  }

}

// ============================================================
// MARKET DATA
// ============================================================

async function getMarketData() {

  const url =
    `https://api.exchange.coinbase.com/products/${CONFIG.PRODUCT_ID}/candles?granularity=300`;

  const response =
    await fetch(
      url,
      {
        headers: {
          Accept:
            "application/json",

          "Cache-Control":
            "no-cache"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `Market API unavailable (${response.status})`
    );

  }

  const rows =
    await response.json();

  if (
    !Array.isArray(rows) ||
    rows.length < 30
  ) {

    throw new Error(
      "Insufficient market data"
    );

  }

  // Coinbase:
  // [time, low, high, open, close, volume]

  const candles =
    rows

      .map(
        row => ({
          time:
            Number(row[0]) *
            1000,

          low:
            Number(row[1]),

          high:
            Number(row[2]),

          open:
            Number(row[3]),

          close:
            Number(row[4]),

          volume:
            Number(row[5])
        })
      )

      .filter(
        candle =>
          Object
            .values(candle)
            .every(
              Number.isFinite
            )
      )

      .sort(
        (a, b) =>
          a.time -
          b.time
      );

  if (
    candles.length <
    30
  ) {

    throw new Error(
      "Insufficient valid candles"
    );

  }

  return {

    candles,

    price:
      candles[
        candles.length - 1
      ].close,

    source:
      "Coinbase Exchange"

  };

}

// ============================================================
// ANALYSIS ENGINE
// ============================================================

function analyzeMarket(
  market
) {

  const closes =
    market.candles.map(
      candle =>
        candle.close
    );

  const volumes =
    market.candles.map(
      candle =>
        candle.volume
    );

  const price =
    closes[
      closes.length - 1
    ];

  // ----------------------------------------------------------
  // TREND
  // ----------------------------------------------------------

  const fastMA =
    average(
      closes.slice(-9)
    );

  const slowMA =
    average(
      closes.slice(-21)
    );

  const bullishTrend =
    fastMA >
    slowMA;

  const bearishTrend =
    fastMA <
    slowMA;

  // ----------------------------------------------------------
  // MOMENTUM
  // ----------------------------------------------------------

  const momentumBase =
    closes[
      closes.length - 6
    ];

  const momentum =
    (
      (
        price -
        momentumBase
      ) /
      momentumBase
    ) *
    100;

  // ----------------------------------------------------------
  // VOLUME
  // ----------------------------------------------------------

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
      ? recentVolume /
        oldVolume
      : 1;

  // ----------------------------------------------------------
  // RANGE / VOLATILITY
  // ----------------------------------------------------------

  const recent =
    closes.slice(-20);

  const high =
    Math.max(
      ...recent
    );

  const low =
    Math.min(
      ...recent
    );

  const rangePercent =
    low > 0
      ? (
          (
            high -
            low
          ) /
          low
        ) *
        100
      : 0;

  // ----------------------------------------------------------
  // BREAKOUT
  // ----------------------------------------------------------

  const previousHigh =
    Math.max(
      ...closes.slice(
        -12,
        -1
      )
    );

  const previousLow =
    Math.min(
      ...closes.slice(
        -12,
        -1
      )
    );

  const bullishBreakout =
    price >
    previousHigh;

  const bearishBreakout =
    price <
    previousLow;

  // ----------------------------------------------------------
  // LONG SCORE
  // ----------------------------------------------------------

  const longBreakdown = {

    trend:
      bullishTrend
        ? 25
        : 0,

    breakout:
      bullishBreakout
        ? 25
        : 0,

    momentum:
      momentum >
      0.35
        ? 20
        : 0,

    volume:
      volumeRatio >
        1.25 &&
      bullishTrend
        ? 15
        : 0,

    range:
      rangePercent >
        1 &&
      bullishTrend
        ? 10
        : 0

  };

  // ----------------------------------------------------------
  // SHORT SCORE
  // ----------------------------------------------------------

  const shortBreakdown = {

    trend:
      bearishTrend
        ? 25
        : 0,

    breakout:
      bearishBreakout
        ? 25
        : 0,

    momentum:
      momentum <
      -0.35
        ? 20
        : 0,

    volume:
      volumeRatio >
        1.25 &&
      bearishTrend
        ? 15
        : 0,

    range:
      rangePercent >
        1 &&
      bearishTrend
        ? 10
        : 0

  };

  const longScore =
    sumBreakdown(
      longBreakdown
    );

  const shortScore =
    sumBreakdown(
      shortBreakdown
    );

  const score =
    Math.max(
      longScore,
      shortScore
    );

  const bias =
    longScore >
    shortScore
      ? "LONG"
      :
    shortScore >
    longScore
      ? "SHORT"
      :
        "NEUTRAL";

  // ----------------------------------------------------------
  // RADAR STAGE
  // ----------------------------------------------------------

  let stage =
    "NORMAL";

  if (
    score >=
    CONFIG.MIN_SCORE
  ) {

    stage =
      "SIGNAL";

  } else if (
    score >= 60
  ) {

    stage =
      "BUILDING";

  } else if (
    score >= 50
  ) {

    stage =
      "WATCH";

  }

  return {

    timestamp:
      Date.now(),

    price,

    longScore,

    shortScore,

    score,

    stage,

    bias,

    trend:
      bullishTrend
        ? "BULLISH"
        :
      bearishTrend
        ? "BEARISH"
        :
          "FLAT",

    breakout:
      bullishBreakout
        ? "UP"
        :
      bearishBreakout
        ? "DOWN"
        :
          "NONE",

    momentum,

    volumeRatio,

    rangePercent,

    fastMA,

    slowMA,

    previousHigh,

    previousLow,

    longBreakdown,

    shortBreakdown,

    source:
      market.source

  };

}

// ============================================================
// BUILD SIGNAL
// ============================================================

function buildSignal(
  analysis
) {

  const side =
    analysis.bias ===
    "SHORT"
      ? "SHORT"
      : "LONG";

  const volatility =
    Math.max(
      analysis.rangePercent /
        100,
      0.005
    );

  const stopDistance =
    analysis.price *
    volatility *
    0.65;

  const entry =
    analysis.price;

  const stop =
    side === "LONG"
      ? entry -
        stopDistance
      : entry +
        stopDistance;

  const tp1 =
    side === "LONG"
      ? entry +
        stopDistance *
        1.25
      : entry -
        stopDistance *
        1.25;

  const tp2 =
    side === "LONG"
      ? entry +
        stopDistance *
        2.2
      : entry -
        stopDistance *
        2.2;

  return {

    id:
      crypto.randomUUID(),

    symbol:
      CONFIG.SYMBOL,

    side,

    score:
      analysis.score,

    entry,

    stop,

    tp1,

    tp2,

    trend:
      analysis.trend,

    breakout:
      analysis.breakout,

    momentum:
      analysis.momentum,

    volumeRatio:
      analysis.volumeRatio,

    rangePercent:
      analysis.rangePercent,

    timestamp:
      Date.now(),

    result:
      "OPEN"

  };

}

// ============================================================
// CREATE PAPER TRADE
// ============================================================

function createPaperTrade(
  state,
  signal
) {

  assertPaperOnly();

  const riskCapital =
    Math.max(
      state.balance,
      0
    ) *
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

    id:
      signal.id,

    side:
      signal.side,

    entry:
      signal.entry,

    stop:
      signal.stop,

    tp1:
      signal.tp1,

    tp2:
      signal.tp2,

    quantity,

    openedAt:
      Date.now(),

    status:
      "OPEN"

  };

}

// ============================================================
// UPDATE PAPER TRADES
// ============================================================

function updateOpenTrades(
  state,
  price
) {

  const closed =
    [];

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

    let outcome =
      null;

    let exit =
      null;

    // --------------------------------------------------------
    // LONG
    // --------------------------------------------------------

    if (
      trade.side ===
      "LONG"
    ) {

      if (
        price <=
        trade.stop
      ) {

        outcome =
          "LOSS";

        exit =
          trade.stop;

      } else if (
        price >=
        trade.tp2
      ) {

        outcome =
          "WIN";

        exit =
          trade.tp2;

      }

    }

    // --------------------------------------------------------
    // SHORT
    // --------------------------------------------------------

    else {

      if (
        price >=
        trade.stop
      ) {

        outcome =
          "LOSS";

        exit =
          trade.stop;

      } else if (
        price <=
        trade.tp2
      ) {

        outcome =
          "WIN";

        exit =
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
            exit -
            trade.entry
          ) *
          trade.quantity

        : (
            trade.entry -
            exit
          ) *
          trade.quantity;

    trade.status =
      outcome;

    trade.exit =
      exit;

    trade.pnl =
      pnl;

    trade.closedAt =
      Date.now();

    state.balance +=
      pnl;

    state.closedTrades.push({
      ...trade
    });

    closed.push({
      ...trade
    });

  }

  state.openTrades =
    state.openTrades.filter(
      trade =>
        trade.status ===
        "OPEN"
    );

  return closed;

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

  // Remember where alerts must go.

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
        "☀️ SOL RADAR PULSE V2 ACTIVADO 🟢",
        "",
        "Escaneo automático: ON",
        "Modo: PAPER TRADING",
        "Frecuencia: cada 5 minutos",
        "",
        "Comandos:",
        "/status",
        "/scan",
        "/why",
        "/stats",
        "/last",
        "/testsignal"
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

    await saveState(
      env,
      state
    );

    await sendTelegram(
      env,
      chatId,
      formatStatus(
        state
      )
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

    await saveState(
      env,
      state
    );

    await sendTelegram(
      env,
      chatId,
      formatStats(
        state
      )
    );

    return json({
      ok: true
    });

  }

  // ----------------------------------------------------------
  // LAST SIGNAL
  // ----------------------------------------------------------

  if (
    command ===
    "/last"
  ) {

    await saveState(
      env,
      state
    );

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

  // ----------------------------------------------------------
  // LIVE SCAN
  // ----------------------------------------------------------

  if (
    command ===
    "/scan"
  ) {

    state.lastScan =
      Date.now();

    state.lastError =
      null;

    try {

      const market =
        await getMarketData();

      const analysis =
        analyzeMarket(
          market
        );

      state.lastAnalysis =
        analysis;

      state.lastSuccessfulScan =
        Date.now();

      recordScan(
        state,
        analysis
      );

      await saveState(
        env,
        state
      );

      await sendTelegram(
        env,
        chatId,
        formatLiveScan(
          analysis
        )
      );

    } catch (error) {

      state.lastError =
        safeError(error);

      await saveState(
        env,
        state
      );

      await sendTelegram(

        env,

        chatId,

        [
          "⚠️ SCAN ERROR",
          "",
          state.lastError
        ].join("\n")

      );

    }

    return json({
      ok: true
    });

  }

  // ----------------------------------------------------------
  // WHY
  // ----------------------------------------------------------

  if (
    command ===
    "/why"
  ) {

    await saveState(
      env,
      state
    );

    await sendTelegram(

      env,

      chatId,

      state.lastAnalysis

        ? formatWhy(
            state.lastAnalysis
          )

        : "🧠 Todavía no hay análisis. Usa /scan primero."

    );

    return json({
      ok: true
    });

  }

  // ----------------------------------------------------------
  // TEST SIGNAL
  // ----------------------------------------------------------

  if (
    command ===
    "/testsignal"
  ) {

    await saveState(
      env,
      state
    );

    await sendTelegram(
      env,
      chatId,
      formatTestSignal()
    );

    return json({
      ok: true
    });

  }

  // ----------------------------------------------------------
  // HELP
  // ----------------------------------------------------------

  await saveState(
    env,
    state
  );

  await sendTelegram(

    env,

    chatId,

    [
      "☀️ SOL RADAR PULSE V2",
      "",
      "/start — activar",
      "/stop — detener",
      "/status — estado",
      "/scan — análisis ahora",
      "/why — explicar análisis",
      "/stats — estadísticas",
      "/last — última señal",
      "/testsignal — alerta DEMO"
    ].join("\n")

  );

  return json({
    ok: true
  });

}

// ============================================================
// TELEGRAM SEND
// ============================================================

async function sendTelegram(
  env,
  chatId,
  text
) {

  if (
    !env.TELEGRAM_BOT_TOKEN
  ) {

    throw new Error(
      "TELEGRAM_BOT_TOKEN missing"
    );

  }

  const response =
    await fetch(

      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,

      {

        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({

            chat_id:
              chatId,

            text

          })

      }

    );

  const data =
    await response.json();

  if (
    !response.ok ||
    !data.ok
  ) {

    throw new Error(
      "Telegram send failed"
    );

  }

  return data;

}

// ============================================================
// FORMAT LIVE SCAN
// ============================================================

function formatLiveScan(
  analysis
) {

  return [

    "📡 SOL RADAR — LIVE SCAN",

    "━━━━━━━━━━━━━━━━",

    `💰 Price: $${formatPrice(
      analysis.price
    )}`,

    "",

    `📈 Long score: ${analysis.longScore}/100`,

    `📉 Short score: ${analysis.shortScore}/100`,

    "",

    `State: ${stageEmoji(
      analysis.stage
    )} ${analysis.stage}`,

    `Trend: ${analysis.trend}`,

    `Momentum: ${signed(
      analysis.momentum
    )}%`,

    `Volume ratio: ${analysis.volumeRatio.toFixed(
      2
    )}x`,

    `Breakout: ${analysis.breakout}`,

    `Range: ${analysis.rangePercent.toFixed(
      2
    )}%`,

    "",

    `🎯 Strongest bias: ${analysis.bias}`,

    "",

    analysis.score >=
      CONFIG.MIN_SCORE

      ? "🚨 Signal conditions detected. /scan did NOT open a trade."

      : "No trade yet. Waiting for the real strategy threshold.",

    "",

    `Data: ${analysis.source}`

  ].join("\n");

}

// ============================================================
// FORMAT WHY
// ============================================================

function formatWhy(
  analysis
) {

  const side =
    analysis.bias ===
    "SHORT"
      ? "SHORT"
      : "LONG";

  const breakdown =
    side === "SHORT"
      ? analysis.shortBreakdown
      : analysis.longBreakdown;

  return [

    "🧠 SOL RADAR — WHY?",

    "━━━━━━━━━━━━━━━━",

    `${side} SCORE: ${analysis.score}/100`,

    "",

    factorLine(
      "Trend",
      breakdown.trend,
      25
    ),

    factorLine(
      "Breakout",
      breakdown.breakout,
      25
    ),

    factorLine(
      "Momentum",
      breakdown.momentum,
      20
    ),

    factorLine(
      "Volume",
      breakdown.volume,
      15
    ),

    factorLine(
      "Volatility/range",
      breakdown.range,
      10
    ),

    "",

    `${stageEmoji(
      analysis.stage
    )} State: ${analysis.stage}`,

    `Bias: ${analysis.bias}`,

    "",

    analysis.stage ===
      "SIGNAL"

      ? "Signal threshold present. Real trade still obeys cooldown/max-trade rules."

      : "Waiting for confirmation.\nNO TRADE YET."

  ].join("\n");

}

// ============================================================
// FORMAT WATCH / BUILDING ALERT
// ============================================================

function formatStageAlert(
  analysis
) {

  if (
    analysis.stage ===
    "WATCH"
  ) {

    return [

      "👀 SOL RADAR — WATCH",

      "",

      `Price: $${formatPrice(
        analysis.price
      )}`,

      `Bias: ${analysis.bias}`,

      `Score: ${analysis.score}/100`,

      "",

      "Market pressure is starting to build.",

      "No entry yet."

    ].join("\n");

  }

  return [

    "⚠️ SOL RADAR — SETUP BUILDING",

    "",

    `Price: $${formatPrice(
      analysis.price
    )}`,

    `Bias: ${analysis.bias}`,

    `Score: ${analysis.score}/100`,

    "",

    `Momentum: ${signed(
      analysis.momentum
    )}% ⚡`,

    `Volume: ${analysis.volumeRatio.toFixed(
      2
    )}x 🔊`,

    "Waiting for confirmation."

  ].join("\n");

}

// ============================================================
// FORMAT REAL SIGNAL
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

    "🚨 SOL RADAR — CONFIRMED SIGNAL",

    "━━━━━━━━━━━━━━━━",

    `${emoji} ${signal.side} SOL`,

    "",

    `Score: ${signal.score}/100`,

    `Entry: $${formatPrice(
      signal.entry
    )}`,

    `SL: $${formatPrice(
      signal.stop
    )}`,

    `TP1: $${formatPrice(
      signal.tp1
    )}`,

    `TP2: $${formatPrice(
      signal.tp2
    )}`,

    "",

    `Trend: ${signal.trend}`,

    `Breakout: ${signal.breakout}`,

    `Momentum: ${signed(
      signal.momentum
    )}%`,

    `Volume: ${signal.volumeRatio.toFixed(
      2
    )}x`,

    "",

    "🧪 PAPER TRADE OPENED"

  ].join("\n");

}

// ============================================================
// FORMAT CLOSED TRADE
// ============================================================

function formatTradeResult(
  trade,
  balance
) {

  const win =
    trade.status ===
    "WIN";

  return [

    `${win ? "✅" : "❌"} SOL RADAR — PAPER TRADE CLOSED`,

    "━━━━━━━━━━━━━━━━",

    `Result: ${trade.status} ${win ? "🟢" : "🔴"}`,

    `Side: ${trade.side}`,

    `Entry: $${formatPrice(
      trade.entry
    )}`,

    `Exit: $${formatPrice(
      trade.exit
    )}`,

    `P&L: ${trade.pnl >= 0 ? "+" : "-"}$${Math.abs(
      trade.pnl
    ).toFixed(2)}`,

    "",

    `New balance: $${balance.toFixed(
      2
    )}`

  ].join("\n");

}

// ============================================================
// FORMAT STATUS
// ============================================================

function formatStatus(
  state
) {

  const analysis =
    state.lastAnalysis;

  const lines = [

    "☀️ SOL RADAR STATUS",

    "━━━━━━━━━━━━━━━━",

    `Radar: ${
      state.active
        ? "🟢 ON"
        : "🔴 OFF"
    }`,

    "",

    `💰 Balance: $${state.balance.toFixed(
      2
    )}`,

    `📡 Signals: ${state.signals.length}`,

    `📂 Open trades: ${state.openTrades.length}`,

    `✅ Closed trades: ${state.closedTrades.length}`

  ];

  if (analysis) {

    lines.push(

      "",

      "Current market:",

      `State: ${stageEmoji(
        analysis.stage
      )} ${analysis.stage}`,

      `Bias: ${analysis.bias}`,

      `Score: ${analysis.score}/100`,

      `Price: $${formatPrice(
        analysis.price
      )}`

    );

  }

  lines.push(

    "",

    `Last scan: ${
      state.lastScan
        ? new Date(
            state.lastScan
          ).toISOString()
        : "Never"
    }`,

    `Last successful scan: ${
      state.lastSuccessfulScan
        ? new Date(
            state.lastSuccessfulScan
          ).toISOString()
        : "Never"
    }`,

    state.lastError

      ? `Last error: ${state.lastError}`

      : "Data status: OK",

    "",

    "Cron: every 5 minutes",

    "Mode: PAPER TRADING"

  );

  return lines.join("\n");

}

// ============================================================
// FORMAT STATS
// ============================================================

function formatStats(
  state
) {

  const wins =
    state.closedTrades.filter(
      trade =>
        trade.status ===
        "WIN"
    ).length;

  const losses =
    state.closedTrades.filter(
      trade =>
        trade.status ===
        "LOSS"
    ).length;

  const total =
    wins +
    losses;

  const winRate =
    total > 0

      ? (
          wins /
          total
        ) *
        100

      : 0;

  const pnl =
    state.closedTrades.reduce(

      (
        sum,
        trade
      ) =>
        sum +
        (
          trade.pnl ||
          0
        ),

      0

    );

  return [

    "📊 SOL RADAR STATS",

    "━━━━━━━━━━━━━━━━",

    `Trades: ${total}`,

    `Wins: ${wins}`,

    `Losses: ${losses}`,

    `Win rate: ${winRate.toFixed(
      1
    )}%`,

    "",

    `P&L: ${pnl >= 0 ? "+" : "-"}$${Math.abs(
      pnl
    ).toFixed(2)}`,

    `Balance: $${state.balance.toFixed(
      2
    )}`,

    `Stored scans: ${state.scanHistory.length}`

  ].join("\n");

}

// ============================================================
// FORMAT TEST SIGNAL
// ============================================================

function formatTestSignal() {

  return [

    "🧪 TEST SIGNAL — DEMO ONLY",

    "━━━━━━━━━━━━━━━━",

    "🚨 SOL RADAR LONG",

    "",

    "Score: 82/100",

    "Entry: $150.00",

    "Stop: $147.50",

    "TP1: $153.12",

    "TP2: $155.50",

    "",

    "⚠️ THIS IS NOT A REAL SIGNAL",

    "⚠️ THIS DOES NOT COUNT IN STATS",

    "⚠️ NO PAPER TRADE WAS OPENED",

    "",

    "✅ Telegram alert pipeline working."

  ].join("\n");

}

// ============================================================
// DEFAULT STATE
// ============================================================

function defaultState() {

  return {

    active:
      false,

    balance:
      CONFIG.STARTING_BALANCE,

    signals:
      [],

    openTrades:
      [],

    closedTrades:
      [],

    scanHistory:
      [],

    lastSignal:
      null,

    lastAnalysis:
      null,

    lastScan:
      null,

    lastSuccessfulScan:
      null,

    lastError:
      null,

    previousStage:
      "NORMAL",

    chatId:
      null

  };

}

// ============================================================
// MIGRATE OLD V1 STATE
// ============================================================

function hydrateState(
  saved
) {

  const state = {

    ...defaultState(),

    ...(
      saved ||
      {}
    )

  };

  state.signals =
    Array.isArray(
      state.signals
    )
      ? state.signals
      : [];

  state.openTrades =
    Array.isArray(
      state.openTrades
    )
      ? state.openTrades
      : [];

  state.closedTrades =
    Array.isArray(
      state.closedTrades
    )
      ? state.closedTrades
      : [];

  state.scanHistory =
    Array.isArray(
      state.scanHistory
    )
      ? state.scanHistory
      : [];

  if (
    !Number.isFinite(
      state.balance
    )
  ) {

    state.balance =
      CONFIG.STARTING_BALANCE;

  }

  if (
    !(
      state.previousStage
      in
      STAGE_RANK
    )
  ) {

    state.previousStage =
      "NORMAL";

  }

  return state;

}

// ============================================================
// LOAD STATE
// ============================================================

async function getState(
  env
) {

  if (
    !env.RADAR_STATE
  ) {

    throw new Error(
      "RADAR_STATE binding missing"
    );

  }

  const saved =
    await env.RADAR_STATE.get(
      "state",
      "json"
    );

  return hydrateState(
    saved
  );

}

// ============================================================
// SAVE STATE
// ============================================================

async function saveState(
  env,
  state
) {

  if (
    !env.RADAR_STATE
  ) {

    throw new Error(
      "RADAR_STATE binding missing"
    );

  }

  state.signals =
    state.signals.slice(
      -CONFIG.MAX_SIGNALS
    );

  state.closedTrades =
    state.closedTrades.slice(
      -CONFIG.MAX_CLOSED
    );

  state.scanHistory =
    state.scanHistory.slice(
      -CONFIG.MAX_SCANS
    );

  await env.RADAR_STATE.put(

    "state",

    JSON.stringify(
      state
    )

  );

}

// ============================================================
// SCAN HISTORY
// ============================================================

function recordScan(
  state,
  analysis
) {

  state.scanHistory.push({

    timestamp:
      analysis.timestamp,

    price:
      analysis.price,

    longScore:
      analysis.longScore,

    shortScore:
      analysis.shortScore,

    score:
      analysis.score,

    stage:
      analysis.stage,

    bias:
      analysis.bias,

    momentum:
      analysis.momentum,

    volumeRatio:
      analysis.volumeRatio,

    breakout:
      analysis.breakout,

    trend:
      analysis.trend

  });

  state.scanHistory =
    state.scanHistory.slice(
      -CONFIG.MAX_SCANS
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
    Number(
      state.lastSignal.timestamp ||
      0
    );

  return (

    elapsed >=

    CONFIG
      .SIGNAL_COOLDOWN_MINUTES *

    60 *

    1000

  );

}

// ============================================================
// PUBLIC STATUS
// ============================================================

function publicStatus(
  state
) {

  return {

    bot:
      "SOL RADAR PULSE",

    version:
      "2.0",

    active:
      state.active,

    balance:
      state.balance,

    signals:
      state.signals.length,

    openTrades:
      state.openTrades.length,

    closedTrades:
      state.closedTrades.length,

    lastScan:
      state.lastScan,

    lastSuccessfulScan:
      state.lastSuccessfulScan,

    lastError:
      state.lastError,

    currentMarket:
      state.lastAnalysis

        ? {

            stage:
              state
                .lastAnalysis
                .stage,

            bias:
              state
                .lastAnalysis
                .bias,

            score:
              state
                .lastAnalysis
                .score,

            price:
              state
                .lastAnalysis
                .price

          }

        : null,

    mode:
      "PAPER TRADING"

  };

}

// ============================================================
// HELPERS
// ============================================================

function sumBreakdown(
  breakdown
) {

  return (

    breakdown.trend +

    breakdown.breakout +

    breakdown.momentum +

    breakdown.volume +

    breakdown.range

  );

}

function factorLine(
  name,
  points,
  maxPoints
) {

  return (

    `${points > 0 ? "✅" : "❌"} ` +

    `${name}: +${points}/${maxPoints}`

  );

}

function stageEmoji(
  stage
) {

  if (
    stage ===
    "SIGNAL"
  ) {

    return "🚨";

  }

  if (
    stage ===
    "BUILDING"
  ) {

    return "⚠️";

  }

  if (
    stage ===
    "WATCH"
  ) {

    return "👀";

  }

  return "🟢";

}

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
      (
        a,
        b
      ) =>
        a +
        b,
      0
    ) /

    values.length

  );

}

function signed(
  value
) {

  const number =
    Number(
      value ||
      0
    );

  return (

    `${number >= 0 ? "+" : ""}` +

    number.toFixed(
      2
    )

  );

}

function formatPrice(
  value
) {

  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    )
  ) {

    return "N/A";

  }

  if (
    number >=
    100
  ) {

    return number.toFixed(
      2
    );

  }

  if (
    number >=
    1
  ) {

    return number.toFixed(
      3
    );

  }

  return number.toFixed(
    5
  );

}

// ============================================================
// HARD PAPER-ONLY GUARD
// ============================================================

function assertPaperOnly() {

  if (
    PAPER_TRADING_ONLY !==
    true
  ) {

    throw new Error(
      "REAL TRADING DISABLED — PAPER TRADING ONLY"
    );

  }

}

// ============================================================
// SAFE ERROR
// ============================================================

function safeError(
  error
) {

  return String(

    error?.message ||

    error ||

    "Unknown error"

  ).slice(
    0,
    250
  );

}

// ============================================================
// JSON RESPONSE
// ============================================================

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