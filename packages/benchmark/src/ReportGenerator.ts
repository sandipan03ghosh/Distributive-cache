/**
 * @flowcache/benchmark — ReportGenerator.ts
 *
 * Turns one or more `PolicyComparisonReport`s into a human-readable
 * Markdown report (for the README / CI artifact) or a machine-readable
 * JSON report (for dashboards or further tooling).
 */

import type { BenchmarkRunResult, PolicyComparisonReport } from './types.js';

export function generateMarkdownReport(reports: readonly PolicyComparisonReport[]): string {
  const lines: string[] = [];

  lines.push('# FlowCache Benchmark Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  for (const report of reports) {
    lines.push(`## Workload: ${report.workloadType}`);
    lines.push('');
    lines.push('| Policy | Throughput (ops/sec) | P50 (ms) | P95 (ms) | P99 (ms) | Errors | Hit Ratio |');
    lines.push('|---|---|---|---|---|---|---|');

    for (const result of report.results) {
      const hitRatio = extractHitRatio(result.metricsAfter);
      lines.push(
        `| ${result.name} ` +
          `| ${result.throughputOpsPerSec.toFixed(1)} ` +
          `| ${result.latency.p50.toFixed(2)} ` +
          `| ${result.latency.p95.toFixed(2)} ` +
          `| ${result.latency.p99.toFixed(2)} ` +
          `| ${result.errors} ` +
          `| ${hitRatio !== null ? `${(hitRatio * 100).toFixed(1)}%` : 'n/a'} |`,
      );
    }

    lines.push('');
    lines.push(`**Best throughput:** ${report.bestThroughput}  `);
    lines.push(`**Best P99 latency:** ${report.bestP99Latency}  `);
    lines.push(`**Best hit ratio:** ${report.bestHitRatio ?? 'n/a'}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function generateJsonReport(reports: readonly PolicyComparisonReport[]): string {
  return JSON.stringify(reports, null, 2);
}

function extractHitRatio(metrics: BenchmarkRunResult['metricsAfter']): number | null {
  if (!metrics) return null;
  const candidate = metrics.overallHitRatio ?? metrics.hitRatio;
  return typeof candidate === 'number' ? candidate : null;
}