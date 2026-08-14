/**
 * News-Lag Arbitrage Agent
 * Uses Vercel AI SDK with AI Gateway to access multiple model providers
 */

import { generateText, stepCountIs } from 'ai';

import {
  analyzeHeadline,
  searchKalshiMarkets,
  getKalshiOrderbook,
  searchPolymarketMarkets,
  estimateFairValue,
  generateTradeRecommendation,

  // Replay Labs - Primary market discovery
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

const SYSTEM_PROMPT = `You are an expert prediction markets arbitrage agent. Your job is to:

1. Analyze breaking news headlines for market impact
2. Find related prediction markets on Kalshi and Polymarket
3. Estimate fair value shifts based on the news
4. Generate trade signals with entry/exit recommendations

WORKFLOW:
1. First, analyze the headline to understand its impact (category, magnitude, direction)
2. Search for related markets on BOTH Kalshi and Polymarket
3. For each relevant market found, estimate fair value given the news
4. Generate trade recommendations for markets with significant edge (>5%)

IMPORTANT:
- Only recommend trades with edge > 5% and confidence > 0.6
- Consider liquidity - avoid markets with < $10,000 liquidity
- Factor in slippage for position sizing
- Be conservative with magnitude estimates
- Verify news if possible before generating signals
- Never invent market prices, liquidity, tickers, or news verification
- Clearly distinguish between verified data and estimates

OUTPUT:
Provide a structured summary of all trade opportunities found.`;

/**
 * Run the arbitrage agent on a news headline
 */
export async function runArbitrageAgent(
  headline: string
): Promise<ArbitrageSignal> {
  const startTime = Date.now();

  const result = await generateText({
    model: gateway(MODELS.primary),

    system: SYSTEM_PROMPT,

    prompt: `Analyze this breaking news and find arbitrage opportunities:

"${headline}"

Steps:
1. Analyze the headline for market impact (category, magnitude, direction)
2. Use semanticSearchMarkets to find related prediction markets on both Polymarket and Kalshi
3. For the top 5 most relevant markets (highest similarity scores), get fresh prices with getMarketPrice
4. Estimate fair value for each market given the news
5. Generate trade recommendations for markets with >5% edge
6. Optionally check for cross-venue overlaps with findMarketOverlaps for arbitrage

Provide a complete analysis with specific trade recommendations.`,

    tools: {
      // News / analysis
      analyzeHeadline,

      // Replay Labs semantic search
      semanticSearchMarkets,
      getMarketPrice,
      findMarketOverlaps,

      // Individual venue searches
      searchKalshiMarkets,
      searchPolymarketMarkets,
      getKalshiOrderbook,

      // Fair value / trade signals
      estimateFairValue,
      generateTradeRecommendation,
    },

    // AI SDK v5-compatible step limit
    stopWhen: stepCountIs(10),

    maxTokens: 4096,
  });

  const markets: MarketSignal[] = [];

  /**
   * Parse tool results from every agent step.
   */
  for (const step of result.steps) {
    for (const toolResult of step.toolResults ?? []) {
      if (
        toolResult.toolName === 'generateTradeRecommendation' &&
        toolResult.result?.recommendation
      ) {
        const rec = toolResult.result.recommendation;

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
    (a, b) => Math.abs(b.edge) - Math.abs(a.edge)
  );

  const duration = Date.now() - startTime;

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
 * Quick analysis without the full agent workflow.
 *
 * Uses Replay Labs semantic search to find related markets
 * across Polymarket and Kalshi.
 */
export async function quickAnalyze(headline: string) {
  /**
   * 1. Analyze headline
   */
  const analysis = await analyzeHeadline.execute(
    { headline },
    {} as any
  );

  /**
   * 2. Search both Polymarket and Kalshi
   * through Replay Labs semantic search.
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
   * 3. Normalize market results.
   */
  const allMarkets = (semanticResult.markets || []).map(
    (result: any) => {
      const m = result.market || result;

      return {
        ...m,

        platform: (
          m.venue ||
          m.platform ||
          'unknown'
        ).toLowerCase(),

        ticker: m.id,

        title: m.question,

        question: m.question,

        yesPrice:
          m.metadata?.yesPrice ??
          m.yesPrice ??
          0.5,

        liquidity:
          m.metadata?.liquidity ??
          m.metadata?.volume ??
          m.liquidity ??
          50000,

        similarityScore:
          result.score ?? 0.5,
      };
    }
  );

  const signals: MarketSignal[] = [];

  /**
   * 4. Analyze the five strongest matching markets.
   */
  for (const market of allMarkets.slice(0, 5)) {
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

    /**
     * Ignore markets without a valid estimate.
     */
    if (!fairValueResult.estimate) {
      continue;
    }

    /**
     * Only continue when the estimated edge
     * is meaningful.
     */
    if (
      Math.abs(
        fairValueResult.estimate.edge
      ) <= 0.03
    ) {
      continue;
    }

    /**
     * Generate trade recommendation.
     */
    const rec =
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
            fairValueResult.estimate.fairValue,

          edge:
            fairValueResult.estimate.edge,

          liquidity:
            market.liquidity ??
            50000,

          maxPositionSize: 250,
        },
        {} as any
      );

    if (!rec.recommendation) {
      continue;
    }

    signals.push({
      platform: market.platform,
      ticker:
        market.ticker ||
        market.id,

      question:
        market.title ||
        market.question,

      currentPrice,

      fairValue:
        fairValueResult.estimate.fairValue,

      edge:
        fairValueResult.estimate.edge,

      edgePercent:
        fairValueResult.estimate.edgePercent,

      signal:
        rec.recommendation.action,

      confidence:
        rec.recommendation.confidence,

      action:
        `${rec.recommendation.action} ${rec.recommendation.side}`,

      suggestedSize:
        rec.recommendation.suggestedSize,

      entryPrice:
        rec.recommendation.entryLimit,

      stopLoss:
        rec.recommendation.stopLoss,

      targetPrice:
        rec.recommendation.takeProfit,

      reasoning:
        rec.recommendation.reasoning,
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
 *
 * Currently retained for future market-search
 * optimization.
 */
function extractKeywords(
  headline: string
): string {
  const stopWords = [
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
  ];

  const words =
    headline
      .toLowerCase()
      .split(/\s+/);

  const keywords =
    words.filter(
      (word) =>
        !stopWords.includes(word) &&
        word.length > 2
    );

  return keywords
    .slice(0, 5)
    .join(' ');
}

/**
 * Generate human-readable summary.
 */
function generateSummary(
  headline: string,
  markets: MarketSignal[]
): string {
  if (markets.length === 0) {
    return `No significant arbitrage opportunities found for: "${headline}"`;
  }

  const topSignals =
    markets.filter(
      (market) =>
        Math.abs(market.edge) > 0.05
    );

  if (topSignals.length === 0) {
    return `Found ${markets.length} related markets but no significant edge (>5%) detected.`;
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

  const bestOpportunity =
    topSignals[0];

  return (
    `Found ${topSignals.length} arbitrage opportunities: ` +
    `${buySignals.length} BUY signals, ` +
    `${sellSignals.length} SELL signals. ` +
    `Best opportunity: ${bestOpportunity.question} ` +
    `with ${Math.round(
      bestOpportunity.edgePercent
    )}% edge.`
  );
}
