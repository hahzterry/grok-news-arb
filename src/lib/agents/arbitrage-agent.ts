/**
 * News-Lag Arbitrage Agent
 * Uses Vercel AI SDK with AI Gateway to access multiple model providers
 */

import { generateText } from 'ai';

import {
  analyzeHeadline,
  searchKalshiMarkets,
  getKalshiOrderbook,
  searchPolymarketMarkets,
  estimateFairValue,
  generateTradeRecommendation,
  semanticSearchMarkets,
  getMarketPrice,
  findMarketOverlaps,
} from '../tools';

import { gateway, MODELS } from '../ai-gateway';

export interface ArbitrageSignal {
  headline: string;
  timestamp: string;
  markets: MarketSignal[];
  summary: string;
}

export interface MarketSignal {
  platform: 'kalshi' | 'polymarket';
  ticker: string;
  question: string;
  currentPrice: number;
  fairValue: number;
  edge: number;
  edgePercent: number;
  signal: string;
  confidence: string;
  action: string;
  suggestedSize: number;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  reasoning: string;
}

const SYSTEM_PROMPT = `You are an expert prediction markets arbitrage agent.

Your job is to:

1. Analyze breaking news headlines for market impact.
2. Find related prediction markets on Kalshi and Polymarket.
3. Estimate fair value shifts based on the news.
4. Generate trade signals with entry and exit recommendations.

WORKFLOW:

1. Analyze the headline to understand:
   - category
   - magnitude
   - direction
   - confidence

2. Search for related markets on BOTH Kalshi and Polymarket.

3. For relevant markets:
   - obtain current prices
   - check liquidity
   - compare current price against estimated fair value

4. Generate trade recommendations only when there is a meaningful edge.

IMPORTANT:

- Only recommend trades with edge > 5%.
- Prefer confidence > 0.6.
- Avoid markets with less than $10,000 liquidity.
- Factor in slippage.
- Be conservative with magnitude estimates.
- Verify breaking news whenever possible.
- Never invent market prices, liquidity, tickers, or news verification.
- Clearly distinguish verified information from estimates.

OUTPUT:

Provide a structured summary of all trade opportunities found.`;

/**
 * Run the full arbitrage agent on a breaking-news headline.
 */
export async function runArbitrageAgent(
  headline: string
): Promise<ArbitrageSignal> {
  const result = await generateText({
    model: gateway(MODELS.primary),

    system: SYSTEM_PROMPT,

    prompt: `Analyze this breaking news and find arbitrage opportunities:

"${headline}"

Follow this workflow:

1. Analyze the headline for market impact.
2. Use semanticSearchMarkets to find related prediction markets across Polymarket and Kalshi.
3. Identify up to the 5 most relevant markets.
4. Use getMarketPrice to obtain fresh prices.
5. Estimate fair value for each market.
6. Generate trade recommendations for opportunities with greater than 5% edge.
7. Optionally use findMarketOverlaps to identify cross-venue arbitrage.

Provide a complete analysis with specific trade recommendations.`,

    tools: {
      analyzeHeadline,

      semanticSearchMarkets,
      getMarketPrice,
      findMarketOverlaps,

      searchKalshiMarkets,
      searchPolymarketMarkets,
      getKalshiOrderbook,

      estimateFairValue,
      generateTradeRecommendation,
    },

    /*
     * IMPORTANT:
     *
     * The installed AI SDK type exposes `steps`,
     * not `step`.
     *
     * Do NOT use:
     *
     * stopWhen: ({ step }) => step >= 10
     *
     * Using `steps.length` avoids the type mismatch.
     */
    stopWhen: ({ steps }) => steps.length >= 10,

    maxTokens: 4096,
  });

  const markets: MarketSignal[] = [];

  /**
   * Parse tool results from each agent step.
   */
  for (const step of result.steps) {
    for (const toolResult of step.toolResults ?? []) {
      if (
        toolResult.toolName ===
          'generateTradeRecommendation' &&
        toolResult.result?.recommendation
      ) {
        const rec =
          toolResult.result.recommendation;

        markets.push({
          platform: rec.platform,
          ticker: rec.marketTicker,
          question: rec.marketQuestion,
          currentPrice: rec.currentPrice,
          fairValue: rec.fairValue,
          edge: rec.edge,
          edgePercent: rec.edgePercent,
          signal: rec.action,
          confidence: rec.confidence,
          action: `${rec.action} ${rec.side}`,
          suggestedSize: rec.suggestedSize,
          entryPrice: rec.entryLimit,
          stopLoss: rec.stopLoss,
          targetPrice: rec.takeProfit,
          reasoning: rec.reasoning,
        });
      }
    }
  }

  /**
   * Sort opportunities by absolute edge.
   */
  markets.sort(
    (a, b) =>
      Math.abs(b.edge) -
      Math.abs(a.edge)
  );

  return {
    headline,
    timestamp: new Date().toISOString(),
    markets: markets.slice(0, 5),
    summary:
      result.text ||
      generateSummary(headline, markets),
  };
}

/**
 * Quick analysis without running the full agent workflow.
 *
 * Uses Replay Labs semantic search to find markets
 * across Polymarket and Kalshi.
 */
export async function quickAnalyze(
  headline: string
) {
  /**
   * 1. Analyze the headline.
   */
  const analysis =
    await analyzeHeadline.execute(
      { headline },
      {} as any
    );

  /**
   * 2. Search both Polymarket and Kalshi.
   */
  const semanticResult =
    await semanticSearchMarkets.execute(
      {
        query: headline,
        limit: 10,
        activeOnly: true,
      },
      {} as any
    );

  /**
   * 3. Normalize the market results.
   */
  const allMarkets = (
    semanticResult.markets || []
  ).map((result: any) => {
    const market =
      result.market || result;

    return {
      ...market,

      platform: String(
        market.venue ||
          market.platform ||
          'unknown'
      ).toLowerCase(),

      ticker:
        market.id,

      title:
        market.question,

      question:
        market.question,

      yesPrice:
        market.metadata?.yesPrice ??
        market.yesPrice ??
        0.5,

      liquidity:
        market.metadata?.liquidity ??
        market.metadata?.volume ??
        market.liquidity ??
        50000,

      similarityScore:
        result.score ?? 0.5,
    };
  });

  const signals: MarketSignal[] = [];

  /**
   * 4. Analyze the five strongest market matches.
   */
  for (
    const market of allMarkets.slice(0, 5)
  ) {
    const currentPrice =
      market.yesPrice ??
      market.outcomes?.[0]?.price ??
      0.5;

    /**
     * Estimate fair value.
     */
    const fairValueResult =
      await estimateFairValue.execute(
        {
          marketQuestion:
            market.title ||
            market.question,

          currentYesPrice:
            currentPrice,

          newsHeadline:
            headline,

          newsMagnitude:
            analysis.analysis?.magnitude ??
            0.5,

          newsDirection:
            analysis.analysis?.direction ??
            'neutral',

          newsConfidence:
            analysis.analysis?.confidence ??
            0.5,

          liquidity:
            market.liquidity ??
            50000,
        },
        {} as any
      );

    if (
      !fairValueResult.estimate
    ) {
      continue;
    }

    /**
     * Ignore insignificant edges.
     */
    if (
      Math.abs(
        fairValueResult.estimate.edge
      ) <= 0.03
    ) {
      continue;
    }

    /**
     * Generate a trade recommendation.
     */
    const recommendation =
      await generateTradeRecommendation.execute(
        {
          marketTicker:
            market.ticker ||
            market.id,

          marketQuestion:
            market.title ||
            market.question,

          platform:
            market.platform,

          currentPrice,

          fairValue:
            fairValueResult
              .estimate
              .fairValue,

          edge:
            fairValueResult
              .estimate
              .edge,

          liquidity:
            market.liquidity ??
            50000,

          maxPositionSize: 250,
        },
        {} as any
      );

    if (
      !recommendation.recommendation
    ) {
      continue;
    }

    const rec =
      recommendation.recommendation;

    signals.push({
      platform:
        market.platform,

      ticker:
        market.ticker ||
        market.id,

      question:
        market.title ||
        market.question,

      currentPrice,

      fairValue:
        fairValueResult
          .estimate
          .fairValue,

      edge:
        fairValueResult
          .estimate
          .edge,

      edgePercent:
        fairValueResult
          .estimate
          .edgePercent,

      signal:
        rec.action,

      confidence:
        rec.confidence,

      action:
        `${rec.action} ${rec.side}`,

      suggestedSize:
        rec.suggestedSize,

      entryPrice:
        rec.entryLimit,

      stopLoss:
        rec.stopLoss,

      targetPrice:
        rec.takeProfit,

      reasoning:
        rec.reasoning,
    });
  }

  /**
   * Sort by absolute edge.
   */
  signals.sort(
    (a, b) =>
      Math.abs(b.edge) -
      Math.abs(a.edge)
  );

  return {
    headline,

    analysis:
      analysis.analysis,

    timestamp:
      new Date().toISOString(),

    markets: signals,

    summary:
      generateSummary(
        headline,
        signals
      ),
  };
}

/**
 * Extract keywords from a headline.
 */
function extractKeywords(
  headline: string
): string {
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'will',
    'be',
    'to',
    'of',
    'in',
    'for',
    'on',
    'by',
  ]);

  const words =
    headline
      .toLowerCase()
      .split(/\s+/);

  const keywords =
    words.filter(
      (word) =>
        !stopWords.has(word) &&
        word.length > 2
    );

  return keywords
    .slice(0, 5)
    .join(' ');
}

/**
 * Generate a human-readable summary.
 */
function generateSummary(
  headline: string,
  markets: MarketSignal[]
): string {
  if (markets.length === 0) {
    return (
      `No significant arbitrage opportunities found for: "${headline}"`
    );
  }

  const topSignals =
    markets.filter(
      (market) =>
        Math.abs(market.edge) > 0.05
    );

  if (topSignals.length === 0) {
    return (
      `Found ${markets.length} related markets but no significant edge (>5%) detected.`
    );
  }

  const buySignals =
    topSignals.filter(
      (market) =>
        market.edge > 0
    );

  const sellSignals =
    topSignals.filter(
      (market) =>
        market.edge < 0
    );

  const best =
    topSignals[0];

  return (
    `Found ${topSignals.length} arbitrage opportunities: ` +
    `${buySignals.length} BUY signals, ` +
    `${sellSignals.length} SELL signals. ` +
    `Best opportunity: ${best.question} ` +
    `with ${Math.round(
      best.edgePercent
    )}% edge.`
  );
}
