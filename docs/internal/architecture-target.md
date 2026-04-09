# Sequant Target Architecture

> Post #503-#508 architecture, scoped after overcomplexity review (2026-04-08).
>
> Guiding principle: **build the tool, not the framework.** Abstractions are added
> when a second consumer forces them, not when the diagram looks prettier.

## System Overview

```mermaid
graph TB
    subgraph Frontends["Entry Points"]
        CLI["CLI<br/><small>Commander.js</small>"]
        MCP["MCP Server<br/><small>stdio / SSE</small>"]
        SDK["Programmatic SDK<br/><small>import { RunOrchestrator }</small>"]
    end

    subgraph Orchestration["Orchestration Layer"]
        RO["RunOrchestrator<br/><small>#503</small>"]
        CR["ConfigResolver<br/><small>#503 / #507</small>"]
        EE["WorkflowEventEmitter<br/><small>#504 — emitter only,<br/>consumers opt-in later</small>"]
    end

    subgraph Execution["Execution Engine"]
        BE["BatchExecutor<br/><small>parallel / sequential / chain</small>"]
        PE["PhaseExecutor<br/><small>retry + cold-start logic</small>"]
        PR["PhaseRegistry<br/><small>#505 — built-in phases only,<br/>user extensibility deferred</small>"]
    end

    subgraph Infrastructure["Infrastructure"]
        WM["WorktreeManager<br/><small>git ops (sync — async deferred)</small>"]
        SM["StateManager<br/><small>atomic writes + locking</small>"]
    end

    subgraph Drivers["Agent Drivers"]
        CC["ClaudeCodeDriver<br/><small>SDK query()</small>"]
        AI["AiderDriver<br/><small>subprocess</small>"]
        CX["CodexDriver<br/><small>#497</small>"]
    end

    subgraph Platforms["Platform Providers"]
        GH["GitHubProvider<br/><small>async gh CLI + GraphQL batch</small>"]
        GL["GitLabProvider<br/><small>#375 — future</small>"]
    end

    subgraph Listeners["Event Listeners (current)"]
        LW["LogWriter<br/><small>direct call</small>"]
        MW["MetricsWriter<br/><small>direct call</small>"]
        PD["ProgressDisplay<br/><small>direct call</small>"]
    end

    subgraph External["External Services"]
        GHAPI["GitHub API"]
        GIT["Git"]
        CCSDK["Claude Code SDK"]
        FS["Filesystem<br/><small>.sequant/state.json</small>"]
    end

    %% Frontend → Orchestrator (all three share the same engine)
    CLI -->|"parse flags →<br/>RunConfig"| RO
    MCP -->|"subprocess<br/>(in-process deferred)"| RO
    SDK -->|"direct call"| RO

    %% Orchestrator internals
    RO --> CR
    RO --> BE
    RO -.->|"emits events"| EE

    %% Execution
    BE --> PE
    PE --> PR
    PR -.->|"resolves<br/>PhaseDefinition"| PE

    %% Infrastructure
    PE --> WM
    PE --> SM
    BE --> SM
    GH -.-> |"async gh CLI"| GHAPI

    %% Drivers
    PE -->|"AgentDriver<br/>interface"| CC
    PE -->|"AgentDriver<br/>interface"| AI
    PE -->|"AgentDriver<br/>interface"| CX

    %% Platforms
    BE --> GH
    BE -.-> GL

    %% Listeners (direct calls for now, event-driven migration deferred)
    BE --> LW
    BE --> MW
    BE --> PD

    %% External
    GH --> GHAPI
    WM --> GIT
    CC --> CCSDK
    SM --> FS
    LW --> FS
    MW --> FS

    %% Styling
    classDef new fill:#e1f5fe,stroke:#0288d1,stroke-width:2px
    classDef future fill:#fff3e0,stroke:#f57c00,stroke-width:1px,stroke-dasharray:5
    classDef existing fill:#f5f5f5,stroke:#616161,stroke-width:1px
    classDef external fill:#fce4ec,stroke:#c62828,stroke-width:1px
    classDef deferred fill:#f3e5f5,stroke:#7b1fa2,stroke-width:1px,stroke-dasharray:3

    class RO,CR,PR new
    class GL,CX future
    class EE deferred
    class CLI,MCP,SDK,BE,PE,WM,SM,CC,AI,GH,LW,MW,PD existing
    class GHAPI,GIT,CCSDK,FS external
```

## Scope Decisions (2026-04-08)

| Issue | Original Scope | Revised Scope | Rationale |
|-------|---------------|---------------|-----------|
| #503 | RunOrchestrator extraction | **Unchanged** | run.ts is 1,171 lines — real problem |
| #507 | Config validation + error types | **Unchanged** | Boundary hardening, quick win |
| #504 | Full event system + consumer migration | **Emitter only** — no LogWriter/MetricsWriter/spinner refactoring | Event bus with 2 riders; migrate consumers when a 4th arrives |
| #505 | Phase plugin framework | **Registry class only** — no user-defined phases, no CLI command | 0 users asking for plugins; consolidate internals only |
| #506 | All async I/O (~30 call sites) | **GitHubProvider async only** — defer WorktreeManager | GitHub API is the bottleneck; worktree ops are per-issue sequential |
| #508 | In-process MCP engine | **Deferred** — fix log polling race separately | Dependency chain cost > benefit at current adoption |

## Layer Responsibilities

```mermaid
graph LR
    subgraph L1["Layer 1: Entry Points"]
        direction TB
        L1A["Parse input format<br/>(CLI flags, MCP params, API args)"]
        L1B["Convert to RunConfig"]
        L1C["Format output<br/>(terminal, MCP response, return value)"]
    end

    subgraph L2["Layer 2: Orchestration"]
        direction TB
        L2A["Resolve configuration<br/>(defaults → settings → env → explicit)"]
        L2B["Coordinate execution<br/>(batch/chain/sequential mode)"]
        L2C["Emit lifecycle events<br/>(optional — consumers opt in)"]
    end

    subgraph L3["Layer 3: Execution"]
        direction TB
        L3A["Execute individual phases"]
        L3B["Resolve phase definitions<br/>(built-in registry)"]
        L3C["Retry with error classification"]
    end

    subgraph L4["Layer 4: Infrastructure"]
        direction TB
        L4A["Git worktree lifecycle"]
        L4B["Persistent state (atomic R/W)"]
        L4C["Platform API abstraction<br/>(async GitHubProvider)"]
    end

    L1 --> L2 --> L3 --> L4

    classDef layer fill:#f5f5f5,stroke:#424242
    class L1,L2,L3,L4 layer
```

## Event Flow

```mermaid
sequenceDiagram
    participant F as Frontend (CLI/MCP/SDK)
    participant O as RunOrchestrator
    participant E as WorkflowEventEmitter
    participant B as BatchExecutor
    participant P as PhaseExecutor
    participant L as LogWriter
    participant M as MetricsWriter
    participant D as ProgressDisplay

    F->>O: execute(RunConfig)
    O->>E: emit(run_started)

    O->>B: executeBatch(issues)

    loop For each issue (p-limit concurrency)
        B->>E: emit(issue_started)
        B->>D: show spinner (direct call)

        loop For each phase
            B->>P: executePhase(issue, phase)
            P->>E: emit(phase_started)
            P->>L: logPhase (direct call)

            P-->>P: run agent driver

            P->>E: emit(phase_completed | phase_failed)
            P->>L: log result (direct call)
            P->>M: record metrics (direct call)
            B->>D: update status (direct call)
        end

        B->>E: emit(issue_completed)
    end

    O->>E: emit(run_completed)
    L->>L: finalize log
    M->>M: write metrics
    D->>D: show summary

    O-->>F: return RunResult

    Note over E: Emitter exists but LogWriter,<br/>MetricsWriter, ProgressDisplay<br/>remain direct calls until a 4th<br/>consumer justifies migration
```

## Configuration Resolution

```mermaid
flowchart LR
    D["Package Defaults<br/><small>settings.ts</small>"] --> CR["ConfigResolver<br/><small>#503 / #507</small>"]
    S[".sequant/settings.json<br/><small>Zod-validated</small>"] --> CR
    E["Environment Variables<br/><small>SEQUANT_*</small>"] --> CR
    F["Explicit Config<br/><small>CLI flags / API args</small>"] --> CR
    CR -->|"validated,<br/>frozen"| RC["RunConfig"]
    RC --> RO["RunOrchestrator"]

    style CR fill:#e1f5fe,stroke:#0288d1,stroke-width:2px
```

## Phase Registry

```mermaid
flowchart TB
    subgraph Registry["PhaseRegistry (#505)"]
        direction TB
        BI["Built-in Phases<br/><small>spec, exec, qa, testgen,<br/>test, verify, loop,<br/>security-review, merger</small>"]
    end

    PD["PhaseDefinition"]
    PD --- |name| N["'spec'"]
    PD --- |skill| SK["'spec'"]
    PD --- |promptTemplate| PT["'Spec {issue}...'"]
    PD --- |requiresWorktree| RW["true"]
    PD --- |retryStrategy| RS["{ maxRetries: 2 }"]
    PD --- |detect| DT["{ labels: ['bug'] }"]
    PD --- |driverOverrides| DO["{ aider: '...' }"]

    Registry --> PE["PhaseExecutor"]
    PE -->|"registry.get(phase)"| PD

    classDef new fill:#e1f5fe,stroke:#0288d1,stroke-width:2px
    class Registry,PD new

    note["User-defined phases deferred<br/>until requested"]
    style note fill:#fff3e0,stroke:#f57c00,stroke-dasharray:5
```

## Dependency Graph (Issues)

```mermaid
flowchart TB
    503["#503 RunOrchestrator<br/><small>Foundation</small>"]
    504["#504 Event Emitter<br/><small>Descoped</small>"]
    505["#505 Phase Registry<br/><small>Descoped</small>"]
    506["#506 Async GitHub I/O<br/><small>Split</small>"]
    507["#507 Config + Errors<br/><small>Standalone</small>"]
    508["#508 In-Process MCP<br/><small>Deferred</small>"]

    503 --> 504
    503 --> 505
    503 --> 506
    504 -.-> 508
    503 -.-> 508

    subgraph B1["Batch 1 (now)"]
        503
        507
    end
    subgraph B2["Batch 2 (next)"]
        504
        505
        506
    end
    subgraph Deferred["Deferred"]
        508
    end

    classDef batch1 fill:#c8e6c9,stroke:#2e7d32
    classDef batch2 fill:#e1f5fe,stroke:#0288d1
    classDef deferred fill:#f3e5f5,stroke:#7b1fa2,stroke-dasharray:5
    classDef standalone fill:#f3e5f5,stroke:#7b1fa2

    class 503 batch1
    class 507 standalone
    class 504,505,506 batch2
    class 508 deferred
```

## Deferred Work

Items intentionally excluded from this iteration. Revisit when triggered:

| Item | Trigger to Revisit |
|------|-------------------|
| User-defined phases (`.sequant/phases/`) | A user files an issue requesting custom phases |
| Event listener migration (LogWriter, MetricsWriter, spinners) | A 4th event consumer is needed (webhooks, VS Code extension) |
| WorktreeManager async migration | Profiling shows git ops as a parallel execution bottleneck |
| In-process MCP engine (#508) | MCP usage grows, or #383 interactive relay becomes priority |
| GitLabProvider / AzureDevOpsProvider | User requests non-GitHub platform support |
| AsyncSubprocess abstraction | Multiple subsystems need shared process lifecycle management |

## Color Key

| Color | Meaning |
|-------|---------|
| Blue fill | New component (active scope) |
| Purple dashed | Deferred — designed but not built yet |
| Orange dashed | Future / planned |
| Gray fill | Existing component (unchanged or refactored) |
| Pink fill | External service |
