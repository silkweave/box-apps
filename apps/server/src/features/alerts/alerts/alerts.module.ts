import { Module, type OnModuleInit } from '@nestjs/common'
import {
  alertRulesReferencingSignal,
  applyAlertPolicy,
  onEvent,
  evaluateInitiativeTargets,
  evaluateSignalRules,
  ingestEvent,
  onRunOutcome,
  registerSignalHooks,
  repointAlertRuleSignals,
} from '@silkweave/box-core'
import { AlertsController } from './alerts.controller.js'

@Module({
  controllers: [AlertsController],
})
export class AlertsModule implements OnModuleInit {
  onModuleInit(): void {
    // Alerts depends on data: rules hold signal ids, so it re-points them on a rename.
    registerSignalHooks({ id: 'alerts', onRename: repointAlertRuleSignals, references: alertRulesReferencingSignal })
    // The alert policy runs on every FRESH event on the spine, whoever recorded it.
    onEvent(async (event) => {
      await applyAlertPolicy(event)
    })
    // Alerts subscribes to core's ops funnel; core does not know alerts exist.
    onRunOutcome(async (outcome) => {
      if (outcome.status === 'success') {
        // A run that may have written signals just succeeded - evaluate the signal rules and the
        // initiative targets against the latest snapshots (both deduped, so this is a no-op unless
        // a value actually moved). Alerts actions don't write signals, so skip them.
        if (outcome.actionId.startsWith('alerts-')) return
        await evaluateSignalRules()
        await evaluateInitiativeTargets()
        return
      }
      // The cheapest alert source: a run just failed. Deduped per run (each failure is real).
      await ingestEvent({
        kind: 'run.error',
        dedup_key: outcome.runId,
        event_at: new Date().toISOString(),
        source: 'funnel',
        subject: outcome.actionId,
        fields: {
          action_id: outcome.actionId,
          run_id: outcome.runId,
          error: outcome.error ?? '',
          trigger: outcome.trigger,
          schedule: outcome.scheduleId ?? '',
        },
      })
    })
  }
}
