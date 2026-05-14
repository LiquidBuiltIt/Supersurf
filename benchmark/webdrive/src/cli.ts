import { Command } from "commander";

const program = new Command();

program
  .name("webdrive")
  .description("Browser agent benchmark — real, hostile DOM patterns")
  .version("0.1.0");

program
  .command("config <action> [key] [value]")
  .description("Manage WebDrive config (actions: get, set, list)")
  .action(async (action: string, key?: string, value?: string) => {
    const { runConfig } = await import("./commands/config");
    await runConfig(action, key, value);
  });

program
  .command("serve")
  .description("Serve challenges over HTTP")
  .option("-p, --port <port>", "Port to listen on", "3737")
  .action(async (opts: { port: string }) => {
    const { runServe } = await import("./commands/serve");
    await runServe(parseInt(opts.port, 10));
  });

program
  .command("score <predictions-file>")
  .description("Score a predictions JSONL file")
  .option("-o, --output <path>", "Write ranked results to this file")
  .action(async (file: string, opts: { output?: string }) => {
    const { runScore } = await import("./commands/score");
    await runScore(file, opts.output);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
