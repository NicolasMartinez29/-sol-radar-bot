import { sendTelegram } from "./telegram.js";

// ============================================================
// ☀️ SOL RADAR PULSE V2.2 RAPID
// PAPER TRADING ONLY — 1 MINUTE RADAR
// ============================================================

const PAPER_TRADING_ONLY = true;

const CONFIG = {
  SYMBOL: "SOL",
  PRODUCT_ID: "SOL-USD",

  MIN_SCORE: 72,
  MAX_OPEN_TRADES: 3,
  SIGNAL_COOLDOWN_MINUTES: 15,

  STARTING_BALANCE: 1000,
  RISK_PER_TRADE: 0.01,

  MARKET_GRANULARITY_SECONDS: 60,
  SNAPSHOT_INTERVAL_MS: 5 * 60 * 1000,

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {

      // ======================================================
      // WEBHOOK SETUP / REPAIR
      // ======================================================

      if (
        url.pathname === "/setup" &&
        request.method === "GET"
      ) {
        return await setupWebhook(
          request,
          env
        );
      }

      // ======================================================
      // TELEGRAM WEBHOOK
      // Accept current + old path
      // ======================================================

      if (
        (
          url.pathname === "/telegram" ||
          url.pathname === "/webhook"
        ) &&
        request.method === "POST"
      ) {
        return await handleTelegram(
          request,
          env
        );
      }

      // ======================================================
      // DEBUG VERSION
      // ======================================================

      if (
        url.pathname === "/debug/version"
      ) {
        return json({
          bot: "SOL RADAR PULSE",
          version: "2.2 RAPID",
          worker: "sol-radar-bot1",
          frequency: "1 minute",
          candleTimeframe: "1 minute",
          webhookPath: "/telegram",
          mode: "PAPER TRADING"
        });
      }

      // ======================================================
      // ROOT
      // ======================================================

      if (
        url.pathname === "/"
      ) {
        return json({
          bot: "SOL RADAR PULSE",
          version: "2.2 RAPID",
          status: "online",
          mode: "PAPER TRADING",
          scanFrequency: "1 minute",
          candleTimeframe: "1 minute"
        });
      }

      // ======================================================
      // PUBLIC STATUS
      // ======================================================

      if (
        url.pathname === "/status"
      ) {
        return json(
          publicStatus(
            await getState(env)
          )
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
          error: safeError(error)
        },
        500
      );
    }
  },

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
// TELEGRAM WEBHOOK SETUP / SELF-REPAIR
// ============================================================

async function setupWebhook(
  request,
  env
) {

  if (
    !env.TELEGRAM_BOT_TOKEN
  ) {

    return json(
      {
        ok: false,
        error:
          "TELEGRAM_BOT_TOKEN missing"
      },
      500
    );
  }

  const origin =
    new URL(
      request.url
    ).origin;

  const webhookUrl =
    `${origin}/telegram`;

  const telegramBase =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

  const setResponse =
    await fetch(
      `${telegramBase}/setWebhook`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            url:
              webhookUrl,

            drop_pending_updates:
              true,

            allowed_updates: [
              "message",
              "edited_message"
            ]
          })
      }
    );

  const setResult =
    await setResponse.json();

  const infoResponse =
    await fetch(
      `${telegramBase}/getWebhookInfo`
    );

  const infoResult =
    await infoResponse.json();

  const info =
    infoResult?.result ||
    {};

  const webhookMatches =
    info.url ===
    webhookUrl;

  return json({
    ok:
      Boolean(
        setResult?.ok &&
        infoResult?.ok &&
        webhookMatches
      ),

    worker:
      "SOL RADAR PULSE V2.2 RAPID",

    expectedWebhook:
      webhookUrl,

    setWebhook: {
      ok:
        Boolean(
          setResult?.ok
        ),

      description:
        setResult?.description ||
        null
    },

    webhookInfo: {
      url:
        info.url ||
        null,

      pendingUpdateCount:
        info.pending_update_count ??
        null,

      lastErrorMessage:
        info.last_error_message ||
        null
    }
  });
}


// ============================================================
// RAPID RADAR LOOP — EVERY MINUTE
// ============================================================

async function runRadar(
  env
) {

  const state =
    await getState(env);

  if (
    !state.active
  ) {
    return;
  }

  const now =
    Date.now();

  try {

    const market =
      await getMarketData();

    const analysis =
      analyzeMarket(
        market
      );

    const previousStage =
      state.previousStage ||
      "NORMAL";

    const stageChanged =
      analysis.stage !==
      previousStage;

    const movedUp =
      STAGE_RANK[
        analysis.stage
      ] >
      STAGE_RANK[
        previousStage
      ];

    const enteredSignal =
      analysis.stage ===
        "SIGNAL" &&
      previousStage !==
        "SIGNAL";

    let dirty =
      false;


    // ========================================================
    // MANAGE OPEN PAPER TRADES
    // ========================================================

    const tradeEvents =
      updateOpenTrades(
        state,
        market.price
      );

    if (
      tradeEvents.length >
      0
    ) {

      dirty =
        true;

      for (
        const event
        of tradeEvents
      ) {

        if (
          !state.chatId
        ) {
          continue;
        }

        if (
          event.type ===
          "TP1"
        ) {

          await sendTelegram(
            env,
            state.chatId,
            formatTp1(
              event.trade
            )
          );
        }

        if (
          event.type ===
          "CLOSED"
        ) {

          await sendTelegram(
            env,
            state.chatId,
            formatTradeResult(
              event.trade,
              state.balance
            )
          );
        }
      }
    }


    // ========================================================
    // STAGE TRANSITIONS
    // ========================================================

    if (
      stageChanged
    ) {

      state.previousStage =
        analysis.stage;

      dirty =
        true;
    }

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


    // ========================================================
    // OPEN PAPER TRADE
    // ========================================================

    const canOpen =
      enteredSignal &&

      analysis.score >=
        CONFIG.MIN_SCORE &&

      state.openTrades.length <
        CONFIG.MAX_OPEN_TRADES &&

      cooldownPassed(
        state
      );

    if (
      canOpen
    ) {

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

      dirty =
        true;

      if (
        state.chatId
      ) {

        await sendTelegram(
          env,
          state.chatId,
          formatSignal(
            signal
          )
        );
      }

    } else if (
      enteredSignal &&
      state.chatId
    ) {

      await sendTelegram(
        env,
        state.chatId,
        formatBlockedSignal(
          analysis,
          state
        )
      );
    }


    // ========================================================
    // SAVE SNAPSHOT ABOUT EVERY 5 MINUTES
    // ========================================================

    const snapshotDue =
      !state.lastSnapshotAt ||

      now -
        state.lastSnapshotAt >=
        CONFIG.SNAPSHOT_INTERVAL_MS;

    if (
      snapshotDue
    ) {

      state.lastAnalysis =
        analysis;

      state.lastScan =
        now;

      state.lastSuccessfulScan =
        now;

      state.lastSnapshotAt =
        now;

      state.lastError =
        null;

      recordScan(
        state,
        analysis
      );

      dirty =
        true;

    } else if (
      dirty
    ) {

      state.lastAnalysis =
        analysis;

      state.lastScan =
        now;

      state.lastSuccessfulScan =
        now;

      state.lastError =
        null;
    }

    if (
      dirty
    ) {

      await saveState(
        env,
        state
      );
    }

  } catch (error) {

    const message =
      safeError(error);

    console.error(
      "RADAR ERROR",
      message
    );

    const shouldPersistError =
      state.lastError !==
        message ||

      !state.lastErrorSavedAt ||

      now -
        state.lastErrorSavedAt >=
        CONFIG.SNAPSHOT_INTERVAL_MS;

    if (
      shouldPersistError
    ) {

      state.lastError =
        message;

      state.lastErrorSavedAt =
        now;

      state.lastScan =
        now;

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
}


// ============================================================
// COINBASE MARKET DATA — 1 MINUTE
// ============================================================

async function getMarketData() {

  const url =
    `https://api.exchange.coinbase.com/products/${CONFIG.PRODUCT_ID}` +
    `/candles?granularity=${CONFIG.MARKET_GRANULARITY_SECONDS}`;

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
            "SOL-RADAR-PULSE/2.2-RAPID"
        }
      }
    );

  if (
    !response.ok
  ) {

    throw new Error(
      `Market API unavailable (${response.status})`
    );
  }

  const rows =
    await response.json();

  if (
    !Array.isArray(rows) ||
    rows.length <
      30
  ) {

    throw new Error(
      "Insufficient market data"
    );
  }

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
          [
            candle.time,
            candle.low,
            candle.high,
            candle.open,
            candle.close,
            candle.volume
          ]
            .every(
              Number.isFinite
            )
      )

      .sort(
        (
          a,
          b
        ) =>
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
        candles.length -
        1
      ].close,

    source:
      "Coinbase Exchange 1m"
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
      closes.length -
      1
    ];


  // ==========================================================
  // TREND
  // ==========================================================

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


  // ==========================================================
  // MOMENTUM
  // ==========================================================

  const momentumBase =
    closes[
      closes.length -
      6
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


  // ==========================================================
  // VOLUME
  // ==========================================================

  const recentVolume =
    average(
      volumes.slice(-5)
    );

  const oldVolume =
    average(
      volumes.slice(-20)
    );

  const volumeRatio =
    oldVolume >
    0

      ? recentVolume /
        oldVolume

      : 1;


  // ==========================================================
  // RANGE
  // ==========================================================

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
    low >
    0

      ? (
          (
            high -
            low
          ) /
          low
        ) *
        100

      : 0;


  // ==========================================================
  // BREAKOUT
  // ==========================================================

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


  // ==========================================================
  // LONG SCORE
  // ==========================================================

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


  // ==========================================================
  // SHORT SCORE
  // ==========================================================

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

      : "NEUTRAL";


  // ==========================================================
  // STAGE
  // ==========================================================

  let stage =
    "NORMAL";

  if (
    score >=
    CONFIG.MIN_SCORE
  ) {

    stage =
      "SIGNAL";

  } else if (
    score >=
    60
  ) {

    stage =
      "BUILDING";

  } else if (
    score >=
    50
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
      0.004
    );

  const stopDistance =
    analysis.price *
    volatility *
    0.65;

  const entry =
    analysis.price;

  const stop =
    side ===
    "LONG"

      ? entry -
        stopDistance

      : entry +
        stopDistance;

  const tp1 =
    side ===
    "LONG"

      ? entry +
        stopDistance *
        1.25

      : entry -
        stopDistance *
        1.25;

  const tp2 =
    side ===
    "LONG"

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

    initialStop:
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
    riskPerUnit >
    0

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

    initialStop:
      signal.stop,

    tp1:
      signal.tp1,

    tp2:
      signal.tp2,

    quantity,

    tp1Hit:
      false,

    breakevenActivated:
      false,

    openedAt:
      Date.now(),

    status:
      "OPEN"
  };
}


// ============================================================
// MANAGE PAPER TRADES
// ============================================================

function updateOpenTrades(
  state,
  price
) {

  const events =
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


    // ========================================================
    // LONG
    // ========================================================

    if (
      trade.side ===
      "LONG"
    ) {

      if (
        price >=
        trade.tp2
      ) {

        outcome =
          "WIN";

        exit =
          trade.tp2;

      } else if (
        !trade.tp1Hit &&
        price >=
        trade.tp1
      ) {

        trade.tp1Hit =
          true;

        trade.breakevenActivated =
          true;

        trade.stop =
          trade.entry;

        events.push({
          type:
            "TP1",

          trade: {
            ...trade
          }
        });

      } else if (
        price <=
        trade.stop
      ) {

        outcome =
          trade.breakevenActivated

            ? "BREAKEVEN"

            : "LOSS";

        exit =
          trade.stop;
      }


    // ========================================================
    // SHORT
    // ========================================================

    } else {

      if (
        price <=
        trade.tp2
      ) {

        outcome =
          "WIN";

        exit =
          trade.tp2;

      } else if (
        !trade.tp1Hit &&
        price <=
        trade.tp1
      ) {

        trade.tp1Hit =
          true;

        trade.breakevenActivated =
          true;

        trade.stop =
          trade.entry;

        events.push({
          type:
            "TP1",

          trade: {
            ...trade
          }
        });

      } else if (
        price >=
        trade.stop
      ) {

        outcome =
          trade.breakevenActivated

            ? "BREAKEVEN"

            : "LOSS";

        exit =
          trade.stop;
      }
    }

    if (
      !outcome
    ) {
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

    events.push({
      type:
        "CLOSED",

      trade: {
        ...trade
      }
    });
  }

  state.openTrades =
    state.openTrades.filter(
      trade =>
        trade.status ===
        "OPEN"
    );

  return events;
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

  if (
    !message
  ) {

    return json({
      ok: true
    });
  }

  const chatId =
    message.chat.id;

  const text =
    message.text ||
    "";

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


  // ==========================================================
  // START
  // ==========================================================

  if (
    command ===
    "/start"
  ) {

    state.active =
      true;

    state.chatId =
      chatId;

    await saveState(
      env,
      state
    );

    await sendTelegram(
      env,
      chatId,

      [
        "☀️ SOL RADAR PULSE V2.2 RAPID ACTIVADO 🟢",
        "",
        "Escaneo automático: ON",
        "Modo: PAPER TRADING",
        "Frecuencia radar: CADA 1 MINUTO ⚡",
        "Velas: 1m",
        "Historial KV: snapshot ~cada 5 minutos",
        "",
        "Comandos:",
        "/status",
        "/scan",
        "/why",
        "/stats",
        "/last",
        "/testsignal",
        "/stop"
      ].join("\n")
    );

    return json({
      ok: true
    });
  }


  // ==========================================================
  // STOP
  // ==========================================================

  if (
    command ===
    "/stop"
  ) {

    state.active =
      false;

    state.chatId =
      chatId;

    await saveState(
      env,
      state
    );

    await sendTelegram(
      env,
      chatId,
      "🛑 SOL RADAR RAPID DETENIDO 🔴\n\nUsa /start para activarlo."
    );

    return json({
      ok: true
    });
  }


  // ==========================================================
  // STATUS
  // ==========================================================

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


  // ==========================================================
  // STATS
  // ==========================================================

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


  // ==========================================================
  // LAST
  // ==========================================================

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

        : "📭 Todavía no hay señales confirmadas."
    );

    return json({
      ok: true
    });
  }


  // ==========================================================
  // MANUAL SCAN
  // ==========================================================

  if (
    command ===
    "/scan"
  ) {

    try {

      const market =
        await getMarketData();

      const analysis =
        analyzeMarket(
          market
        );

      state.lastAnalysis =
        analysis;

      state.lastScan =
        Date.now();

      state.lastSuccessfulScan =
        Date.now();

      state.lastError =
        null;

      state.chatId =
        chatId;

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

      state.lastErrorSavedAt =
        Date.now();

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
        `⚠️ SCAN ERROR\n\n${state.lastError}`
      );
    }

    return json({
      ok: true
    });
  }


  // ==========================================================
  // WHY
  // ==========================================================

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


  // ==========================================================
  // TEST SIGNAL
  // ==========================================================

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


  // ==========================================================
  // HELP
  // ==========================================================

  await sendTelegram(
    env,
    chatId,

    [
      "☀️ SOL RADAR PULSE V2.2 RAPID",
      "",
      "/start — activar radar 1m",
      "/stop — detener",
      "/status — estado",
      "/scan — análisis AHORA",
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
// FORMAT LIVE SCAN
// ============================================================

function formatLiveScan(
  analysis
) {

  return [

    "⚡ SOL RADAR RAPID — LIVE SCAN 1M",

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

      ? "🚨 SIGNAL CONDITIONS DETECTED. Manual /scan did NOT open a trade."

      : "Waiting for confirmation.",

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
    side ===
    "SHORT"

      ? analysis.shortBreakdown

      : analysis.longBreakdown;

  return [

    "🧠 SOL RADAR RAPID — WHY?",

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

      ? "Signal threshold present. Auto paper entry still obeys cooldown + max-trade rules."

      : "Waiting for confirmation. NO TRADE YET."

  ].join("\n");
}


// ============================================================
// FORMAT STAGE ALERT
// ============================================================

function formatStageAlert(
  analysis
) {

  if (
    analysis.stage ===
    "WATCH"
  ) {

    return [

      "👀 SOL RADAR RAPID — WATCH",

      "",

      `Price: $${formatPrice(
        analysis.price
      )}`,

      `Bias: ${analysis.bias}`,

      `Score: ${analysis.score}/100`,

      "",

      "Pressure is starting to build.",

      "No entry yet."

    ].join("\n");
  }

  return [

    "⚠️ SOL RADAR RAPID — SETUP BUILDING",

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
// FORMAT SIGNAL
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

    "🚨 SOL RADAR RAPID — CONFIRMED SIGNAL",

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
// FORMAT TP1
// ============================================================

function formatTp1(
  trade
) {

  return [

    "🥇 SOL RADAR RAPID — TP1 HIT",

    "━━━━━━━━━━━━━━━━",

    `Side: ${trade.side}`,

    `Entry: $${formatPrice(
      trade.entry
    )}`,

    `TP1: $${formatPrice(
      trade.tp1
    )}`,

    "",

    "🛡️ Paper stop moved to BREAKEVEN.",

    `New stop: $${formatPrice(
      trade.stop
    )}`,

    "Holding paper trade for TP2."

  ].join("\n");
}


// ============================================================
// FORMAT CLOSED TRADE
// ============================================================

function formatTradeResult(
  trade,
  balance
) {

  const icon =
    trade.status ===
    "WIN"

      ? "✅"

      :
    trade.status ===
    "BREAKEVEN"

      ? "🟨"

      : "❌";

  return [

    `${icon} SOL RADAR RAPID — PAPER TRADE CLOSED`,

    "━━━━━━━━━━━━━━━━",

    `Result: ${trade.status}`,

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
// FORMAT BLOCKED SIGNAL
// ============================================================

function formatBlockedSignal(
  analysis,
  state
) {

  let reason =
    "risk rule";

  if (
    state.openTrades.length >=
    CONFIG.MAX_OPEN_TRADES
  ) {

    reason =
      "max open trades reached";

  } else if (
    !cooldownPassed(
      state
    )
  ) {

    reason =
      "signal cooldown active";
  }

  return [

    "🚨 SOL RADAR RAPID — SIGNAL DETECTED",

    "━━━━━━━━━━━━━━━━",

    `Bias: ${analysis.bias}`,

    `Score: ${analysis.score}/100`,

    `Price: $${formatPrice(
      analysis.price
    )}`,

    "",

    `⚠️ No new paper trade: ${reason}.`

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

    "☀️ SOL RADAR RAPID STATUS",

    "━━━━━━━━━━━━━━━━",

    `Radar: ${
      state.active

        ? "🟢 ON"

        : "🔴 OFF"
    }`,

    "Frequency: ⚡ every 1 minute",

    "Candle timeframe: 1m",

    "",

    `💰 Balance: $${state.balance.toFixed(
      2
    )}`,

    `📡 Signals: ${state.signals.length}`,

    `📂 Open trades: ${state.openTrades.length}`,

    `✅ Closed trades: ${state.closedTrades.length}`
  ];

  if (
    analysis
  ) {

    lines.push(

      "",

      "Last persisted market snapshot:",

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

    `Last saved scan: ${
      state.lastScan

        ? new Date(
            state.lastScan
          ).toISOString()

        : "Never"
    }`,

    `Last successful saved scan: ${
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

  const breakevens =
    state.closedTrades.filter(
      trade =>
        trade.status ===
        "BREAKEVEN"
    ).length;

  const total =
    wins +
    losses +
    breakevens;

  const decisive =
    wins +
    losses;

  const winRate =
    decisive >
    0

      ? (
          wins /
          decisive
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

    "📊 SOL RADAR RAPID STATS",

    "━━━━━━━━━━━━━━━━",

    `Closed trades: ${total}`,

    `Wins: ${wins}`,

    `Losses: ${losses}`,

    `Breakeven: ${breakevens}`,

    `Win rate (ex-BE): ${winRate.toFixed(
      1
    )}%`,

    "",

    `P&L: ${pnl >= 0 ? "+" : "-"}$${Math.abs(
      pnl
    ).toFixed(2)}`,

    `Balance: $${state.balance.toFixed(
      2
    )}`,

    `Stored snapshots: ${state.scanHistory.length}`,

    `Open trades: ${state.openTrades.length}`

  ].join("\n");
}


// ============================================================
// TEST SIGNAL
// ============================================================

function formatTestSignal() {

  return [

    "🧪 SOL RADAR RAPID — TEST SIGNAL",

    "━━━━━━━━━━━━━━━━",

    "🚨 LONG SOL — DEMO ONLY",

    "",

    "Score: 82/100",

    "Entry: $77.00",

    "SL: $76.50",

    "TP1: $77.63",

    "TP2: $78.10",

    "",

    "⚠️ NOT A REAL SIGNAL",

    "⚠️ DOES NOT COUNT IN STATS",

    "⚠️ NO PAPER TRADE OPENED",

    "",

    "✅ Telegram pipeline working."

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

    lastSnapshotAt:
      null,

    lastError:
      null,

    lastErrorSavedAt:
      null,

    previousStage:
      "NORMAL",

    chatId:
      null
  };
}


// ============================================================
// HYDRATE STATE
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

  state.openTrades =
    state.openTrades.map(
      trade => ({

        ...trade,

        initialStop:
          Number.isFinite(
            trade.initialStop
          )

            ? trade.initialStop

            : trade.stop,

        tp1Hit:
          Boolean(
            trade.tp1Hit
          ),

        breakevenActivated:
          Boolean(
            trade.breakevenActivated
          )
      })
    );

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
// GET STATE
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

  const payload =
    JSON.stringify(
      state
    );

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
// RECORD SCAN
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

    CONFIG.SIGNAL_COOLDOWN_MINUTES *
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
      "2.2 RAPID",

    active:
      state.active,

    frequency:
      "1 minute",

    candleTimeframe:
      "1 minute",

    balance:
      state.balance,

    signals:
      state.signals.length,

    openTrades:
      state.openTrades.length,

    closedTrades:
      state.closedTrades.length,

    lastSavedScan:
      state.lastScan,

    lastSuccessfulSavedScan:
      state.lastSuccessfulScan,

    lastError:
      state.lastError,

    currentMarket:
      state.lastAnalysis

        ? {

            stage:
              state.lastAnalysis.stage,

            bias:
              state.lastAnalysis.bias,

            score:
              state.lastAnalysis.score,

            price:
              state.lastAnalysis.price
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
    Number(
      value
    );

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
// PAPER ONLY GUARD
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