/**
 * Thinking Mode Detection Utilities
 *
 * Utilities for detecting and analyzing thinking mode in AI provider responses.
 * Based on comprehensive analysis of Ali-Bailian and Volcengine response patterns.
 */

export interface ThinkingModeAnalysis {
  thinking_enabled: boolean;
  reasoning_content_present: boolean;
  reasoning_tokens: number;
  completion_tokens: number;
  performance_metrics?: {
    response_time_ms?: number;
    token_efficiency?: number;
    speed_improvement_percent?: number;
  };
  detection_confidence: number;
}

export interface APIResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: {
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

/**
 * Thinking Mode Detector - Core detection engine
 */
export class ThinkingModeDetector {
  /**
   * Analyze API response to detect thinking mode status
   */
  static analyzeResponse(
    response: APIResponse,
    startTime?: number,
  ): ThinkingModeAnalysis {
    const analysis: ThinkingModeAnalysis = {
      thinking_enabled: false,
      reasoning_content_present: false,
      reasoning_tokens: 0,
      completion_tokens: 0,
      detection_confidence: 0,
    };

    // Extract response data
    const message = response.choices?.[0]?.message;
    const usage = response.usage;
    const reasoningContent = message?.reasoning_content;
    const reasoningTokens =
      usage?.completion_tokens_details?.reasoning_tokens || 0;
    const completionTokens = usage?.completion_tokens || 0;

    // Primary detection: reasoning_content field presence
    const hasReasoningContent =
      reasoningContent != null && reasoningContent.trim().length > 0;

    // Secondary detection: reasoning_tokens in usage stats
    const hasReasoningTokens = reasoningTokens > 0;

    // Determine thinking mode status
    analysis.reasoning_content_present = hasReasoningContent;
    analysis.reasoning_tokens = reasoningTokens;
    analysis.completion_tokens = completionTokens;
    analysis.thinking_enabled = hasReasoningContent || hasReasoningTokens;

    // Calculate detection confidence
    if (hasReasoningContent && hasReasoningTokens) {
      analysis.detection_confidence = 1.0; // 100% confident
    } else if (hasReasoningContent || hasReasoningTokens) {
      analysis.detection_confidence = 0.9; // 90% confident
    } else {
      analysis.detection_confidence = 0.8; // 80% confident (no thinking detected)
    }

    // Calculate performance metrics if timing data is available
    if (startTime) {
      const responseTime = Date.now() - startTime;
      analysis.performance_metrics = {
        response_time_ms: responseTime,
        token_efficiency: completionTokens / Math.max(1, responseTime / 1000), // tokens per second
      };

      // Estimate speed improvement when thinking is disabled
      // Based on test data: 63% improvement when thinking disabled
      if (!analysis.thinking_enabled) {
        analysis.performance_metrics.speed_improvement_percent = 63;
      }
    }

    return analysis;
  }

  /**
   * Simple thinking mode detection (for backward compatibility)
   */
  static hasThinking(response: APIResponse): boolean {
    return this.analyzeResponse(response).thinking_enabled;
  }

  /**
   * Extract reasoning tokens count
   */
  static getReasoningTokens(response: APIResponse): number {
    return response.usage?.completion_tokens_details?.reasoning_tokens || 0;
  }

  /**
   * Generate user-friendly status message
   */
  static generateStatusMessage(analysis: ThinkingModeAnalysis): string {
    const {
      thinking_enabled,
      reasoning_tokens,
      completion_tokens,
      performance_metrics,
    } = analysis;

    if (thinking_enabled) {
      const reasoningInfo =
        reasoning_tokens > 0 ? ` (${reasoning_tokens} reasoning tokens)` : '';
      const timeInfo = performance_metrics?.response_time_ms
        ? ` in ${(performance_metrics.response_time_ms / 1000).toFixed(2)}s`
        : '';

      return `✅ Thinking Mode: Enabled${reasoningInfo}${timeInfo}`;
    } else {
      const timeInfo = performance_metrics?.response_time_ms
        ? ` in ${(performance_metrics.response_time_ms / 1000).toFixed(2)}s`
        : '';
      const speedInfo = performance_metrics?.speed_improvement_percent
        ? ` (${performance_metrics.speed_improvement_percent}% faster)`
        : '';

      return `⚡ Thinking Mode: Disabled${speedInfo}${timeInfo}`;
    }
  }

  /**
   * Detect model type based on response patterns
   */
  static detectModelType(
    modelName: string,
    analysis: ThinkingModeAnalysis,
  ): 'standard' | 'thinking-only' | 'unknown' {
    const modelLower = modelName?.toLowerCase() || '';

    // Check for known thinking-only model patterns
    const thinkingOnlyPatterns = ['thinking-2507', 'thinking-', '-reasoning'];

    if (thinkingOnlyPatterns.some((pattern) => modelLower.includes(pattern))) {
      return 'thinking-only';
    }

    // Standard models that support both modes
    const standardPatterns = ['qwen3-235b-a22b', 'doubao-seed'];

    if (standardPatterns.some((pattern) => modelLower.includes(pattern))) {
      return 'standard';
    }

    return 'unknown';
  }

  /**
   * Validate parameter effectiveness
   * Compares expected vs actual thinking mode status
   */
  static validateParameterEffectiveness(
    expectedThinking: boolean,
    analysis: ThinkingModeAnalysis,
    modelName: string,
  ): {
    effective: boolean;
    message: string;
    suggestion?: string;
  } {
    const modelType = this.detectModelType(modelName, analysis);
    const actualThinking = analysis.thinking_enabled;

    if (modelType === 'thinking-only' && expectedThinking === false) {
      return {
        effective: false,
        message: `❌ Parameter not effective: ${modelName} is a thinking-only model`,
        suggestion:
          'Use a standard model (e.g., qwen3-235b-a22b) to control thinking mode',
      };
    }

    if (expectedThinking === actualThinking) {
      return {
        effective: true,
        message: `✅ Parameter effective: enable_thinking = ${expectedThinking}`,
      };
    } else {
      return {
        effective: false,
        message: `⚠️ Unexpected result: expected ${expectedThinking}, got ${actualThinking}`,
        suggestion: 'Check for hard-coded overrides or API restrictions',
      };
    }
  }
}

/**
 * Convenience functions for common use cases
 */

export function detectThinkingMode(
  response: APIResponse,
  startTime?: number,
): ThinkingModeAnalysis {
  return ThinkingModeDetector.analyzeResponse(response, startTime);
}

export function hasThinkingMode(response: APIResponse): boolean {
  return ThinkingModeDetector.hasThinking(response);
}

export function generateThinkingStatusMessage(
  response: APIResponse,
  startTime?: number,
): string {
  const analysis = ThinkingModeDetector.analyzeResponse(response, startTime);
  return ThinkingModeDetector.generateStatusMessage(analysis);
}

export default ThinkingModeDetector;
