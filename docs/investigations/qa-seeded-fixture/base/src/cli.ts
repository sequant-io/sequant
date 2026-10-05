#!/usr/bin/env node
import { Command } from "commander";
import * as store from "./store.js";

const program = new Command();
program.name("notes").description("A tiny notes CLI");

program
  .command("list")
  .option("--store <file>", "note store", "notes.json")
  .action((opts: { store: string }) => {
    for (const n of store.readNotesFile(opts.store)) {
      console.log(`${n.id}\t${n.title}`);
    }
  });

program.parse();
