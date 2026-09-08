#!/usr/bin/env node
import chalk from 'chalk';
import Table from 'cli-table3';
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_WORKING_CONFIG } from './config.js';
import { OllamaDriver, probeOllama } from './agent/driver.js';
import { AgentLoop } from './agent/loop.js';
import { PersistentMemoryStore } from './memory/persistent.js';
import { DiskStore } from './store/disk.js';
import { readBaseline, renderComparison, writeBaseline } from './eval/compare.js';
import { renderTable } from './eval/metrics.js';
import { readScenarios, runEval } from './eval/runner.js';
import { MEMORY_STRATEGIES, type MemoryStrategy, type ScriptStep } from './types.js';

function findWorkspaceRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function demoScript(task: string, files: number): ScriptStep[] {
  const steps: ScriptStep[] = [
    { tool: 'list_dir', args: { dir: 'src/auth' }, output: 'auth/login.ts auth/session.ts auth/middleware.ts' },
    { tool: 'grep', args: { pattern: 'auth' }, output: `${files * 7} call sites reference the auth module` },
  ];
  for (let i = 1; i <= files; i++) {
    steps.push({
      tool: 'read_file',
      args: { path: `src/auth/file${i}.ts` },
      output: `content of file${i} with auth imports`,
    });
    steps.push({
      tool: 'propose_edit',
      args: { path: `src/auth/file${i}.ts`, diff: `rename auth usage ${i}` },
      output: `applied edit to src/auth/file${i}.ts`,
      completes: `file${i}`,
    });
  }
  steps.push({ tool: 'finish', args: { answer: `completed: ${task}` }, output: `completed: ${task}` });
  return steps;
}

const program = new Command();
program.name('memory').description('Task 6 long-horizon memory CLI');

program
  .command('run')
  .description('run the memory-backed agent on a task')
  .requiredOption('--task <task>', 'task description')
  .option('--strategy <strategy>', `memory strategy (${MEMORY_STRATEGIES.join('|')})`, 'tiered_memory')
  .option('--max-steps <n>', 'step budget', '15')
  .option('--files <n>', 'demo call-site files to process (scripted fallback)', '6')
  .option('--repo <path>', 'repo directory for live runs (default: demo-repo)')
  .option('--deterministic', 'run in deterministic scripted mode')
  .option('--live', 'force live mode via Ollama')
  .option('--resume', 'resume an interrupted run from checkpoint')
  .action(async (opts: { task: string; strategy: string; maxSteps: string; files: string; repo?: string; deterministic?: boolean; live?: boolean; resume?: boolean }) => {
    if (!(MEMORY_STRATEGIES as string[]).includes(opts.strategy)) {
      console.error(chalk.red(`✖ Unknown strategy: ${opts.strategy}`));
      process.exitCode = 1;
      return;
    }
    const strategy = opts.strategy as MemoryStrategy;
    const root = findWorkspaceRoot(process.cwd());
    const isOllamaUp = await probeOllama();
    const live = opts.deterministic ? false : isOllamaUp;
    // Separate state dirs: a scripted checkpoint must never leak into a live run.
    const dir = join(process.cwd(), live ? '.memory-live' : '.memory');
    const store = new DiskStore(dir);
    if (!opts.resume) {
      store.clearAll();
    }
    const runId = `cli-${Date.now()}`;
    let loop: AgentLoop;
    let mode: 'live' | 'deterministic' = 'deterministic';

    console.log(chalk.cyan.bold(
      `\n┌─────────────────────────────────────────────────────────────┐\n` +
      `│            Task 6 — Long-Horizon Memory Agent               │\n` +
      `└─────────────────────────────────────────────────────────────┘`
    ));
    console.log(`  ${chalk.bold('Task:')}     ${chalk.white(opts.task)}`);
    console.log(`  ${chalk.bold('Strategy:')} ${chalk.cyan.bold(strategy)}`);
    console.log(`  ${chalk.bold('Mode:')}     ${live ? chalk.magenta.bold('live (Ollama qwen2.5:7b)') : chalk.blue.bold('deterministic simulation')}`);
    console.log(`  ${chalk.bold('Budget:')}   ${opts.maxSteps} max steps\n`);

    if (live) {
      mode = 'live';
      const trajectoryPath = join(dir, 'trajectory.jsonl');
      const repoDir = opts.repo ?? join(root, 'demo-repo');
      const { readdirSync, readFileSync, writeFileSync } = await import('node:fs');
      // Ensure demo-repo starts clean so the agent exercises the live fix
      const authPath = join(repoDir, 'src', 'auth.js');
      if (existsSync(authPath)) {
        const content = readFileSync(authPath, 'utf8');
        if (content.includes('logout')) {
          const clean = "function login(user) {\n  if (!user) throw new Error('user required');\n  return { user, token: `t-${user}` };\n}\n\nfunction session(token) {\n  return typeof token === 'string' && token.startsWith('t-');\n}\n\nmodule.exports = { login, session };\n";
          writeFileSync(authPath, clean, 'utf8');
        }
      }
      const repoTree = readdirSync(repoDir).join(' ').slice(0, 500);
      loop = new AgentLoop({
        task: opts.task,
        strategy,
        store,
        persistent: new PersistentMemoryStore(store, runId),
        config: DEFAULT_WORKING_CONFIG,
        driver: new OllamaDriver({ repoTree }),
        executor: 'live',
        repoDir,
        trajectoryPath,
        runId,
        maxSteps: Number(opts.maxSteps),
      });
    } else {
      loop = new AgentLoop({
        task: opts.task,
        strategy,
        store,
        persistent: new PersistentMemoryStore(store, runId),
        config: DEFAULT_WORKING_CONFIG,
        script: demoScript(opts.task, Number(opts.files)),
        runId,
        maxSteps: Number(opts.maxSteps),
      });
    }

    const result = await loop.run();

    const summaryTable = new Table({
      head: [chalk.cyan.bold('Metric'), chalk.cyan.bold('Value')],
      style: { head: [], border: ['dim'] },
    });

    const statusText = result.completed
      ? chalk.green.bold('✔ Completed')
      : chalk.red.bold(`✖ Incomplete (${result.reason})`);

    const usagePct = (result.maxUsageRatio * 100).toFixed(0);
    const usageColor = result.maxUsageRatio > 1.0 ? chalk.red : result.maxUsageRatio >= 0.75 ? chalk.yellow : chalk.green;

    summaryTable.push(
      [chalk.white('Status'), statusText],
      [chalk.white('Termination Reason'), chalk.dim(result.reason)],
      [chalk.white('Steps Executed'), `${result.stepsExecuted} / ${opts.maxSteps}`],
      [chalk.white('Memory Compactions'), chalk.yellow(String(result.compactions))],
      [chalk.white('Peak Context Usage'), usageColor(`${usagePct}% of cap`)],
      [chalk.white('Tool-Call Errors'), result.toolCallErrors === 0 ? chalk.green('0') : chalk.red(String(result.toolCallErrors))],
    );

    console.log(summaryTable.toString());

    if (result.finalAnswer) {
      console.log(chalk.green.bold('\n✔ Final Answer:'));
      console.log(chalk.white(`  ${result.finalAnswer}\n`));
    } else {
      console.log(chalk.yellow(`\n(No final answer produced: ${result.reason})\n`));
    }
  });

program
  .command('eval')
  .description('run the 12-scenario golden memory set via Ollama')
  .option('--scenarios <path>', 'path to golden-memory.jsonl')
  .option('--strategies <list>', `comma-separated subset of ${MEMORY_STRATEGIES.join(',')}`)
  .option('--limit <number>', 'limit evaluation to first N scenarios')
  .option('--compare <path>', 'baseline.json to compare against')
  .option('--save <path>', 'write results as a baseline.json file')
  .option('--deterministic', 'run in offline deterministic simulation mode (fast)')
  .action(
    async (opts: { scenarios?: string; strategies?: string; limit?: string; compare?: string; save?: string; deterministic?: boolean }) => {
      const root = findWorkspaceRoot(process.cwd());
      const scenariosPath = opts.scenarios ?? join(root, 'evals', 'golden-memory.jsonl');
      const strategies = opts.strategies
        ? (opts.strategies.split(',').map((s) => s.trim()) as MemoryStrategy[])
        : undefined;
      let scenarios = readScenarios(scenariosPath);
      if (opts.limit) {
        scenarios = scenarios.slice(0, Number(opts.limit));
      }
      const t0 = Date.now();

      console.log(chalk.cyan.bold(
        `\n┌─────────────────────────────────────────────────────────────┐\n` +
        `│         Task 6 — Golden Memory Evaluation Benchmark         │\n` +
        `└─────────────────────────────────────────────────────────────┘`
      ));

      if (!opts.deterministic) {
        const ollamaUp = await probeOllama();
        if (!ollamaUp) {
          console.error(chalk.red.bold('\n✖ Error: Ollama server is not reachable at http://localhost:11434.'));
          console.error(chalk.yellow('Evaluation must be performed by Ollama only. Please ensure Ollama is running:'));
          console.error(chalk.cyan('  ollama serve'));
          console.error(chalk.cyan('  ollama pull qwen2.5:7b-instruct'));
          console.error(chalk.cyan('  ollama pull nomic-embed-text\n'));
          process.exit(1);
        }
      }

      const modeLabel = opts.deterministic
        ? chalk.blue.bold('deterministic simulation (offline)')
        : chalk.magenta.bold('live (Ollama qwen2.5:7b + nomic-embed-text)');
      console.log(`  ${chalk.bold('Mode:')}       ${modeLabel}`);
      console.log(`  ${chalk.bold('Scenarios:')}  ${scenarios.length} (7 standard, 3 recall-dependent, 2 pollution)`);
      const totalRuns = (strategies?.length ?? MEMORY_STRATEGIES.length) * scenarios.length;
      console.log(`  ${chalk.bold('Evaluating:')} ${strategies?.length ?? 4} memory strategies (${totalRuns} total runs)...\n`);

      let lastScenarioId = '';
      const report = await runEval(scenarios, {
        strategies,
        driverMode: opts.deterministic ? 'scripted' : 'live',
        onProgress: (scenario, strategy, current, total) => {
          if (scenario.id !== lastScenarioId) {
            console.log(`  ${chalk.dim(`[${scenario.category}]`)} ${chalk.white.bold(scenario.id)}`);
            lastScenarioId = scenario.id;
          }
          const stratColor = strategy === 'tiered_memory' ? chalk.green.bold : strategy === 'no_memory' ? chalk.red : chalk.cyan;
          process.stdout.write(`    [${current}/${total}] ${stratColor(strategy.padEnd(20))} ... `);
        },
        onFinishRun: (_scenario, _strategy, result) => {
          if (result.completed) {
            console.log(chalk.green(`✔ complete (${result.stepsExecuted} steps, ${(result.maxUsageRatio * 100).toFixed(0)}% cap)`));
          } else {
            console.log(chalk.yellow(`terminated (${(result.maxUsageRatio * 100).toFixed(0)}% cap, ${result.stepsExecuted} steps)`));
          }
        },
      });

      console.log('');
      console.log(renderTable(report.metrics));

      const durationSec = ((Date.now() - t0) / 1000).toFixed(2);
      console.log(chalk.dim(`\nEvaluated ${report.results.length} runs in ${durationSec}s`));

      const problems = report.results.filter(
        (r) => !r.completed || r.resumeCorrect === false || r.recallCorrect === false || r.polluted === true,
      );

      if (problems.length > 0) {
        const noMemCount = problems.filter((p) => p.strategy === 'no_memory').length;
        const naiveRecallMiss = problems.filter((p) => p.strategy === 'naive_truncation' && p.recallCorrect === false).length;
        const sumRecallMiss = problems.filter((p) => p.strategy === 'summarization_only' && p.recallCorrect === false).length;
        const tieredProblems = problems.filter((p) => p.strategy === 'tiered_memory').length;

        console.log(chalk.bold.yellow(`\nStrategy Behavioral Breakdown:`));
        console.log(`  • ${chalk.white('no_memory:')}          ${chalk.red(`${noMemCount} aborts`)} (exceeds budget past cap as expected)`);
        console.log(`  • ${chalk.white('naive_truncation:')}   ${chalk.red(`${naiveRecallMiss} recall misses`)} (drops load-bearing context as expected)`);
        console.log(`  • ${chalk.white('summarization_only:')} ${chalk.red(`${sumRecallMiss} recall misses`)} (loses exact payloads as expected)`);
        console.log(`  • ${chalk.white('tiered_memory:')}      ${tieredProblems === 0 ? chalk.green.bold('0 failures (100% recall & budget adherence)') : chalk.red(`${tieredProblems} issues`)}`);
      }

      if (opts.save) {
        writeBaseline(resolve(opts.save), report.metrics);
        console.log(chalk.green(`\n✔ Saved baseline to ${resolve(opts.save)}`));
      }
      if (opts.compare) {
        const compareCandidate = resolve(opts.compare);
        const inPackageCandidate = join(root, 'packages', 'memory', opts.compare);
        const target = existsSync(compareCandidate)
          ? compareCandidate
          : existsSync(inPackageCandidate)
          ? inPackageCandidate
          : compareCandidate;
        console.log(renderComparison(report.metrics, readBaseline(target)));
      }
      console.log('');
    },
  );

program.parseAsync(process.argv);

