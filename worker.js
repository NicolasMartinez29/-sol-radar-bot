import { sendTelegram } from "./telegram.js";

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

const STAGE_RANK = { NORMAL: 0, WATCH: 1, BUILDING: 2, SIGNAL: 3 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/telegram" && request.method === "POST") {
        return await handleTelegram(request, env);
      }

      if (url.pathname === "/") {
        return json({
          bot: "SOL RADAR PULSE",
          version: "2.1",
          status: "online",
          mode: "PAPER TRADING"
        });
      }

      if (url.pathname === "/status") {
        return json(publicStatus(await getState(env)));
      }

      return json({ error: "Not found" }, 404);

    } catch (error) {
      console.error("FETCH ERROR", safeError(error));

      return json({
        error: safeError(error)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRadar(env));
  }
};


// ============================================================
// RADAR LOOP
// ============================================================

async function runRadar(env) {

  const state = await getState(env);

  if (!state.active) {
    return;
  }

  state.lastScan = Date.now();
  state.lastError = null;

  try {

    const market = await getMarketData();

    const analysis = analyzeMarket(market);

    const previousStage =
      state.previousStage || "NORMAL";


    // --------------------------------------------------------
    // UPDATE OPEN PAPER TRADES
    // --------------------------------------------------------

    const closedNow =
      updateOpenTrades(
        state,
        market.price
      );


    // --------------------------------------------------------
    // STORE CURRENT ANALYSIS
    // --------------------------------------------------------

    state.lastAnalysis =
      analysis;

    recordScan(
      state,
      analysis
    );


    // --------------------------------------------------------
    // CLOSED TRADE ALERTS
    // --------------------------------------------------------

    for (const trade of closedNow) {

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


    // --------------------------------------------------------
    // STAGE TRANSITION
    // --------------------------------------------------------

    const movedUp =
      STAGE_RANK[
        analysis.stage
      ] >
      STAGE_RANK[
        previousStage
      ];


    // --------------------------------------------------------
    // WATCH / BUILDING ALERT
    // --------------------------------------------------------

    if (
      movedUp &&
      state.chatId &&
      (
        analysis.stage === "WATCH" ||
        analysis.stage === "BUILDING"
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


    // --------------------------------------------------------
    // REAL PAPER SIGNAL
    // --------------------------------------------------------

    const enteredSignal =
      analysis.stage === "SIGNAL" &&
      previousStage !== "SIGNAL";


    const canOpen =
      enteredSignal &&
      analysis.score >= CONFIG.MIN_SCORE &&
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


    // Save current stage.
    // If stage drops, it happens silently.
    // This allows a future rise to trigger again.

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

    console.error(
      "RADAR ERROR",
      state.lastError
    );


    try {

      await saveState(
        env,
        state
      );

    } catch (saveError) {

      console.error(
        "STATE SAVE ERROR",
        safeError(saveError)
      );

    }

  }

}


// ============================================================
// MARKET DATA
// Coinbase SOL-USD 5 minute candles
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
            "no-cache",

          "User-Agent":
            "SOL-RADAR-PULSE/2.1"

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
        c =>
          [
            c.time,
            c.low,
            c.high,
            c.open,
            c.close,
            c.volume
          ]
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
      c =>
        c.close
    );


  const volumes =
    market.candles.map(
      c =>
        c.volume
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
      momentum > 0.35
        ? 20
        : 0,

    volume:
      volumeRatio > 1.25 &&
      bullishTrend
        ? 15
        : 0,

    range:
      rangePercent > 1 &&
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
      momentum < -0.35
        ? 20
        : 0,

    volume:
      volumeRatio > 1.25 &&
      bearishTrend
        ? 15
        : 0,

    range:
      rangePercent > 1 &&
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

      : "NEUTRAL";


  // ----------------------------------------------------------
  // STAGE
  // ----------------------------------------------------------

  let stage =
    "NORMAL";


  if (
    score >=
    CONFIG.MIN_SCORE
  ) {

    stage =
      "SIGNAL";

  }

  else if (
    score >= 60
  ) {

    stage =
      "BUILDING";

  }

  else if (
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

        : "FLAT",

    breakout:
      bullishBreakout

        ? "UP"

        :
      bearishBreakout

        ? "DOWN"

        : "NONE",

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
// PAPER TRADE
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
// UPDATE OPEN TRADES
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

      }

      else if (
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

      }

      else if (
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
      t =>
        t.status ===
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


  const message =
    update.message ||
    update.edited_message;


  if (!message) {

    return json({
      ok: true
    });

  }


  const chatId =
    message.chat.id;


  const text =
    message.text ||
    "";


  // This also handles:
  // /why@BotUsername
  // /status@BotUsername

  const command =
    (
      (
        text
          .trim()
          .split(/\s+/)[0] ||
        ""
      )
        .toLowerCase()
    )
      .split("@")[0];


  const state =
    await getState(env);


  // Remember the Telegram chat where alerts should go.
  // It is persisted on /start, /stop and /scan.

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
        "☀️ SOL RADAR PULSE V2.1 ACTIVADO 🟢",
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
  // READ ONLY — NO KV WRITE
  // ----------------------------------------------------------

  if (
    command ===
    "/status"
  ) {

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
  // READ ONLY — NO KV WRITE
  // ----------------------------------------------------------

  if (
    command ===
    "/stats"
  ) {

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
  // LAST
  // READ ONLY — NO KV WRITE
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


  // ----------------------------------------------------------
  // SCAN
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


      try {

        await saveState(
          env,
          state
        );

      } catch (saveError) {

        console.error(
          "SCAN SAVE ERROR",
          safeError(saveError)
        );

      }


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
  // READ ONLY — NO KV WRITE
  // ----------------------------------------------------------

  if (
    command ===
    "/why"
  ) {

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
  // READ ONLY — NO KV WRITE
  // ----------------------------------------------------------

  if (
    command ===
    "/testsignal"
  ) {

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

  await sendTelegram(

    env,

    chatId,

    [
      "☀️ SOL RADAR PULSE V2.1",
      "",
      "/start — activar",
      "/stop — detener",
      "/status — estado",
      "/scan — análisis ahora",
      "/why — explicar último análisis",
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
// FORMATTING
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
// WHY
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

      ? "Signal threshold present. Real paper trade still obeys cooldown/max-trade rules."

      : "Waiting for confirmation.\nNO TRADE YET."

  ].join("\n");

}


// ============================================================
// WATCH / BUILDING ALERT
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
// REAL PAPER SIGNAL
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
// TRADE RESULT
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
// STATUS
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
// STATS
// ============================================================

function formatStats(
  state
) {

  const wins =
    state.closedTrades.filter(
      t =>
        t.status ===
        "WIN"
    ).length;


  const losses =
    state.closedTrades.filter(
      t =>
        t.status ===
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
        t
      ) =>
        sum +
        (
          t.pnl ||
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
// DEMO SIGNAL
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
// HYDRATE OLD STATE
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
// GET KV STATE
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
// SAVE KV STATE
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


  const payload =
    JSON.stringify(
      state
    );


  // Retry if cron + manual command hit the same KV key
  // at practically the same time.

  for (
    let attempt = 0;
    attempt < 3;
    attempt++
  ) {

    try {

      await env.RADAR_STATE.put(
        "state",
        payload
      );


      return;


    } catch (error) {

      const message =
        String(
          error?.message ||
          error
        );


      const rateLimited =
        message.includes(
          "429"
        );


      if (
        !rateLimited ||
        attempt === 2
      ) {

        throw error;

      }


      await scheduler.wait(

        1100 +

        Math.floor(
          Math.random() *
          400
        )

      );

    }

  }

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
// PUBLIC STATUS ENDPOINT
// ============================================================

function publicStatus(
  state
) {

  return {

    bot:
      "SOL RADAR PULSE",

    version:
      "2.1",

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
  b
) {

  return (

    b.trend +

    b.breakout +

    b.momentum +

    b.volume +

    b.range

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

  const n =
    Number(
      value ||
      0
    );


  return (

    `${n >= 0 ? "+" : ""}` +

    n.toFixed(
      2
    )

  );

}


function formatPrice(
  value
) {

  const n =
    Number(
      value
    );


  if (
    !Number.isFinite(
      n
    )
  ) {

    return "N/A";

  }


  if (
    n >= 100
  ) {

    return n.toFixed(
      2
    );

  }


  if (
    n >= 1
  ) {

    return n.toFixed(
      3
    );

  }


  return n.toFixed(
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
// JSON
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