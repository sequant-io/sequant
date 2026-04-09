# Sequant Target Architecture

> Post #503-#508 architecture. This is the design we're building toward.

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
        EE["WorkflowEventEmitter<br/><small>#504</small>"]
    end

    subgraph Execution["Execution Engine"]
        BE["BatchExecutor<br/><small>parallel / sequential / chain</small>"]
        PE["PhaseExecutor<br/><small>retry + cold-start logic</small>"]
        PR["PhaseRegistry<br/><small>#505 — built-in + user phases</small>"]
    end

    subgraph Infrastructure["Infrastructure"]
        WM["WorktreeManager<br/><small>async git ops</small>"]
        SM["StateManager<br/><small>atomic writes + locking</small>"]
        AS["AsyncSubprocess<br/><small>#506</small>"]
    end

    subgraph Drivers["Agent Drivers"]
        CC["ClaudeCodeDriver<br/><small>SDK query()</small>"]
        AI["AiderDriver<br/><small>subprocess</small>"]
        CX["CodexDriver<br/><small>#497</small>"]
    end

    subgraph Platforms["Platform Providers"]
        GH["GitHubProvider<br/><small>async gh CLI + GraphQL batch</small>"]
        GL["GitLabProvider<br/><small>#375 — future</small>"]
        AZ["AzureDevOpsProvider<br/><small>#375 — future</small>"]
    end

    subgraph Listeners["Event Listeners"]
        LW["LogWriter"]
        MW["MetricsWriter"]
        PD["ProgressDisplay<br/><small>CLI spinners</small>"]
        MN["MCP Notifications<br/><small>real-time streaming</small>"]
        WH["Webhooks<br/><small>future</small>"]
    end

    subgraph External["External Services"]
        GHAPI["GitHub API"]
        GIT["Git"]
        CCSDK["Claude Code SDK"]
        FS["Filesystem<br/><small>.sequant/state.json</small>"]
    end

    %% Frontend → Orchestrator (all three share the same engine)
    CLI -->|"parse flags →<br/>RunConfig"| RO
    MCP -->|"in-process<br/>#508"| RO
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
    WM --> AS
    GH --> AS

    %% Drivers
    PE -->|"AgentDriver<br/>interface"| CC
    PE -->|"AgentDriver<br/>interface"| AI
    PE -->|"AgentDriver<br/>interface"| CX

    %% Platforms
    BE --> GH
    BE -.-> GL
    BE -.-> AZ

    %% Event listeners (fire-and-forget)
    EE -.->|"subscribe"| LW
    EE -.->|"subscribe"| MW
    EE -.->|"subscribe"| PD
    EE -.->|"subscribe"| MN
    EE -.->|"subscribe"| WH

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

    class RO,CR,EE,PR,AS new
    class GL,AZ,CX,WH,MN future
    class CLI,MCP,SDK,BE,PE,WM,SM,CC,AI,GH,LW,MW,PD existing
    class GHAPI,GIT,CCSDK,FS external
```

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
        L2C["Emit lifecycle events"]
    end

    subgraph L3["Layer 3: Execution"]
        direction TB
        L3A["Execute individual phases"]
        L3B["Resolve phase definitions<br/>(built-in + user-defined)"]
        L3C["Retry with error classification"]
    end

    subgraph L4["Layer 4: Infrastructure"]
        direction TB
        L4A["Git worktree lifecycle"]
        L4B["Persistent state (atomic R/W)"]
        L4C["Async subprocess execution"]
        L4D["Platform API abstraction"]
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
    E-->>L: log run start
    E-->>D: show banner

    O->>B: executeBatch(issues)

    loop For each issue (p-limit concurrency)
        B->>E: emit(issue_started)
        E-->>D: show spinner

        loop For each phase
            B->>P: executePhase(issue, phase)
            P->>E: emit(phase_started)
            E-->>D: update spinner
            E-->>L: log phase start

            P-->>P: run agent driver

            P->>E: emit(phase_completed | phase_failed)
            E-->>L: log phase result
            E-->>M: record metrics
            E-->>D: update status
        end

        B->>E: emit(issue_completed)
    end

    O->>E: emit(run_completed)
    E-->>L: finalize log
    E-->>M: write metrics
    E-->>D: show summary

    O-->>F: return RunResult
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
        UD["User-Defined Phases<br/><small>.sequant/phases/deploy/<br/>.sequant/phases/perf-test/</small>"]
    end

    PD["PhaseDefinition"]
    PD --- |name| N["'deploy'"]
    PD --- |skill| SK["'deploy'"]
    PD --- |promptTemplate| PT["'Deploy {issue} to...'"]
    PD --- |requiresWorktree| RW["true"]
    PD --- |retryStrategy| RS["{ maxRetries: 2 }"]
    PD --- |detect| DT["{ labels: ['deploy'] }"]
    PD --- |driverOverrides| DO["{ aider: '...', codex: '...' }"]

    Registry --> PE["PhaseExecutor"]
    PE -->|"registry.get(phase)"| PD

    classDef new fill:#e1f5fe,stroke:#0288d1,stroke-width:2px
    class Registry,PD new
```

## Dependency Graph (Issues)

```mermaid
flowchart TB
    503["#503 RunOrchestrator<br/><small>Foundation</small>"]
    504["#504 Event System"]
    505["#505 Phase Registry"]
    506["#506 Async I/O"]
    507["#507 Config + Errors<br/><small>Standalone</small>"]
    508["#508 In-Process MCP"]

    503 --> 504
    503 --> 505
    503 --> 506
    504 --> 508
    503 --> 508

    subgraph B1["Batch 1"]
        503
        507
    end
    subgraph B2["Batch 2"]
        504
        505
        506
    end
    subgraph B3["Batch 3"]
        508
    end

    classDef batch1 fill:#c8e6c9,stroke:#2e7d32
    classDef batch2 fill:#e1f5fe,stroke:#0288d1
    classDef batch3 fill:#fff3e0,stroke:#f57c00
    classDef standalone fill:#f3e5f5,stroke:#7b1fa2

    class 503 batch1
    class 507 standalone
    class 504,505,506 batch2
    class 508 batch3
```

## Color Key

| Color | Meaning |
|-------|---------|
| Blue fill | New component (from #503-#508) |
| Orange dashed | Future / planned |
| Gray fill | Existing component (unchanged or refactored) |
| Pink fill | External service |
