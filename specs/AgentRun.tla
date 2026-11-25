------------------------------- MODULE AgentRun -------------------------------
EXTENDS FiniteSets

CONSTANTS Sessions, Runs, NoRun
ASSUME NoRun \notin Runs

VARIABLES runs, status, owner, retryOf, rootOf, activeLock, pendingStop, terminal, recovered
vars == <<runs, status, owner, retryOf, rootOf, activeLock, pendingStop, terminal, recovered>>

Active == {"pending", "running"}
Terminal == {"completed", "stopped", "failed"}
ActiveRuns == {r \in runs : status[r] \in Active}

Init ==
  /\ runs = {}
  /\ status = [r \in {} |-> "pending"]
  /\ owner = [r \in {} |-> NoRun]
  /\ retryOf = [r \in {} |-> NoRun]
  /\ rootOf = [r \in {} |-> NoRun]
  /\ activeLock = [s \in Sessions |-> NoRun]
  /\ pendingStop = {}
  /\ terminal = [r \in Runs |-> NoRun]
  /\ recovered = FALSE

Create(s, r, parent, root) ==
  /\ r \in Runs \ runs
  /\ activeLock[s] = NoRun
  /\ runs' = runs \cup {r}
  /\ status' = [i \in runs' |-> IF i = r THEN "pending" ELSE status[i]]
  /\ owner' = [i \in runs' |-> IF i = r THEN s ELSE owner[i]]
  /\ retryOf' = [i \in runs' |-> IF i = r THEN parent ELSE retryOf[i]]
  /\ rootOf' = [i \in runs' |-> IF i = r THEN root ELSE rootOf[i]]
  /\ activeLock' = [activeLock EXCEPT ![s] = r]
  /\ recovered' = FALSE
  /\ UNCHANGED <<pendingStop, terminal>>

StartRun(s, r) == Create(s, r, NoRun, r)

BeginRun(r) ==
  /\ r \in runs
  /\ status[r] = "pending"
  /\ r \notin pendingStop
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ UNCHANGED <<runs, owner, retryOf, rootOf, activeLock, pendingStop, terminal, recovered>>

Finish(r, outcome) ==
  /\ r \in ActiveRuns
  /\ status' = [status EXCEPT ![r] = outcome]
  /\ terminal' = [terminal EXCEPT ![r] = outcome]
  /\ activeLock' = [activeLock EXCEPT ![owner[r]] = NoRun]
  /\ pendingStop' = pendingStop \ {r}
  /\ UNCHANGED <<runs, owner, retryOf, rootOf, recovered>>

CompleteRun(r) == /\ r \in ActiveRuns /\ status[r] = "running" /\ Finish(r, "completed")
FailRun(r) == Finish(r, "failed")

RequestStop(r) ==
  /\ r \in ActiveRuns
  /\ pendingStop' = pendingStop \cup {r}
  /\ UNCHANGED <<runs, status, owner, retryOf, rootOf, activeLock, terminal, recovered>>

FinishStop(r) == /\ r \in pendingStop /\ Finish(r, "stopped")

RetryRun(r, source) ==
  /\ source \in runs
  /\ status[source] \in {"stopped", "failed"}
  /\ Cardinality({i \in runs : rootOf[i] = rootOf[source]}) < 4
  /\ Create(owner[source], r, source, rootOf[source])

RestartRecover ==
  /\ ActiveRuns # {}
  /\ status' = [r \in runs |-> IF r \in ActiveRuns THEN "failed" ELSE status[r]]
  /\ terminal' = [r \in Runs |-> IF r \in ActiveRuns THEN "failed" ELSE terminal[r]]
  /\ activeLock' = [s \in Sessions |-> NoRun]
  /\ pendingStop' = {}
  /\ recovered' = TRUE
  /\ UNCHANGED <<runs, owner, retryOf, rootOf>>

Next ==
  \/ RestartRecover
  \/ \E r \in pendingStop : FinishStop(r)
  \/ /\ pendingStop = {}
     /\ \/ \E s \in Sessions, r \in Runs : StartRun(s, r)
        \/ \E r \in runs : BeginRun(r) \/ CompleteRun(r) \/ FailRun(r) \/ RequestStop(r)
        \/ \E r \in Runs, source \in runs : RetryRun(r, source)

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

\* These properties map to the same four named assertions in run-invariants.test.ts.
TerminalIrreversible == \A r \in runs : terminal[r] # NoRun => status[r] = terminal[r]
OneActiveRunPerSession ==
  \A s \in Sessions :
    {r \in ActiveRuns : owner[r] = s} = IF activeLock[s] = NoRun THEN {} ELSE {activeLock[s]}
\* Once requested, the next effective transition must release the lease or recover the run.
CancelBoundedConvergence == [](\A r \in pendingStop : status'[r] \in Terminal \/ UNCHANGED vars)
PendingStopsSettle == \A r \in Runs : (r \in pendingStop) ~> (r \in runs /\ status[r] \in Terminal)
NoZombiesAfterRestart == recovered => (ActiveRuns = {} /\ pendingStop = {})

=============================================================================
