export const PARAM_NAMES = {
  "common.days": [
    "n"
  ],
  "common.d": [
    "n"
  ],
  "common.couldNotSave": [
    "msg"
  ],
  "app.loadFailed": [
    "err"
  ],
  "rel.inDays": [
    "n"
  ],
  "rel.daysAgo": [
    "n"
  ],
  "today.hi": [
    "name"
  ],
  "today.phase.late": [
    "n"
  ],
  "today.ringLabel": [
    "day",
    "phase"
  ],
  "today.expected": [
    "range"
  ],
  "today.fertile": [
    "from",
    "to"
  ],
  "today.startCheck.title": [
    "date"
  ],
  "today.alerts.positiveTestBody": [
    "date"
  ],
  "today.alerts.lateTitle": [
    "n"
  ],
  "today.alerts.watchingBody": [
    "n",
    "coverline"
  ],
  "today.nfp.infertileUntil": [
    "date"
  ],
  "today.nfp.preBody": [
    "rule"
  ],
  "today.nfp.postBody": [
    "date"
  ],
  "today.log.symptoms": [
    "n"
  ],
  "day.tempRange": [
    "min",
    "max"
  ],
  "day.quick.stop": [
    "s"
  ],
  "day.quick.preparing": [
    "pct"
  ],
  "day.quick.voiceFailed": [
    "msg"
  ],
  "day.quick.pair": [
    "label",
    "value"
  ],
  "chart.current": [
    "day"
  ],
  "chart.shiftConfirmed": [
    "day",
    "rule",
    "firstHigh",
    "coverline"
  ],
  "chart.shiftPending": [
    "n",
    "coverline"
  ],
  "chart.peakFound": [
    "day",
    "category",
    "confirmedDay"
  ],
  "chart.peakBleeding": [
    "day",
    "confirmedDay"
  ],
  "chart.mucusGaps": [
    "days"
  ],
  "chart.ovulationFound": [
    "day",
    "method"
  ],
  "chart.luteal": [
    "n"
  ],
  "chart.doubleCheckDone": [
    "day"
  ],
  "chart.dayN": [
    "n"
  ],
  "chart.exclusionIgnored": [
    "days"
  ],
  "insights.sd": [
    "sd"
  ],
  "insights.cycleCount": [
    "n"
  ],
  "insights.lastCycles": [
    "n"
  ],
  "insights.fromConfirmed": [
    "n"
  ],
  "insights.period": [
    "n"
  ],
  "insights.ovulationDay": [
    "day",
    "method"
  ],
  "insights.lutealShort": [
    "n"
  ],
  "settings.data.imported": [
    "n"
  ],
  "settings.data.importFailed": [
    "msg"
  ],
  "settings.devices.lastActive": [
    "when"
  ],
  "settings.voice.whisperHint": [
    "mb"
  ],
  "settings.voice.download": [
    "mb"
  ],
  "settings.voice.downloading": [
    "pct"
  ],
  "settings.voice.failed": [
    "msg"
  ],
  "settings.about.version": [
    "v"
  ],
  "notifications.sent": [
    "n"
  ],
  "notifications.couldNotEnable": [
    "msg"
  ],
  "notifications.timezone": [
    "tz"
  ],
  "notifications.timeOf": [
    "label"
  ],
  "notifications.before": [
    "n"
  ],
  "lock.couldNotAddBiometric": [
    "msg"
  ],
  "lock.biometrics": [
    "name"
  ],
  "lock.added": [
    "date"
  ],
  "lockScreen.digits": [
    "n"
  ],
  "lockScreen.wrongPin": [
    "left"
  ],
  "sharing.since": [
    "date"
  ],
  "sharing.stopConfirm": [
    "name"
  ],
  "sharing.pending": [
    "date"
  ],
  "sharing.cycleOf": [
    "name"
  ],
  "passwordErrors.length": [
    "min"
  ],
  "account.local": [
    "username"
  ],
  "account.newPassword": [
    "min"
  ],
  "account.twoFactorOn": [
    "left"
  ],
  "admin.twoFactorPolicy": [
    "value"
  ],
  "admin.sso": [
    "configured",
    "url"
  ],
  "admin.localNetworks": [
    "list"
  ],
  "admin.connection": [
    "local",
    "viaPublicUrl",
    "secure"
  ],
  "admin.temporaryPassword": [
    "username"
  ],
  "admin.created": [
    "created",
    "last"
  ],
  "admin.resetTwoFactorConfirm": [
    "name"
  ],
  "admin.deleteConfirm": [
    "name"
  ],
  "partner.paused": [
    "name"
  ],
  "partner.late": [
    "n"
  ],
  "partner.ovulation": [
    "confirmed",
    "date"
  ],
  "partner.stats": [
    "mean",
    "sd",
    "min",
    "max",
    "periodMean"
  ],
  "partner.sharedBy": [
    "name",
    "items"
  ],
  "partner.stopConfirm": [
    "name"
  ],
  "partner.card.summary": [
    "day",
    "phase",
    "next"
  ],
  "partner.card.late": [
    "n"
  ],
  "invite.wants": [
    "name"
  ],
  "invite.never": [
    "name"
  ],
  "invite.choice.follow": [
    "name"
  ],
  "auth.signInWith": [
    "provider"
  ],
  "auth.newPassword": [
    "min"
  ],
  "push.period": [
    "n"
  ],
  "push.partner": [
    "name",
    "n"
  ]
} as const;

export const PLURAL_PATHS = [
  "common.days",
  "rel.inDays",
  "rel.daysAgo",
  "today.phase.late",
  "today.alerts.lateTitle",
  "today.alerts.watchingBody",
  "today.log.symptoms",
  "chart.shiftPending",
  "insights.cycleCount",
  "insights.lastCycles",
  "insights.fromConfirmed",
  "settings.data.imported",
  "notifications.sent",
  "notifications.before",
  "lockScreen.digits",
  "lockScreen.wrongPin",
  "account.twoFactorOn",
  "partner.late"
] as const;
