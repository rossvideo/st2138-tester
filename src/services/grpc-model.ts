const GRPC_ALARM_SEVERITY_VALUES: Record<string, number> = {
  EMERGENCY: 0,
  ALERT: 1,
  CRITICAL: 2,
  ERROR: 3,
  WARNING: 4,
  NOTICE: 5,
  INFORMATIONAL: 6,
  DEBUG: 7
};

export function normalizeProtoModel(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeProtoModel);
  if (!value || typeof value !== 'object') return value;

  const normalized: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'kind' || child === null || child === undefined) continue;
    normalized[key] = key === 'severity' && typeof child === 'string'
      && Object.prototype.hasOwnProperty.call(GRPC_ALARM_SEVERITY_VALUES, child)
      ? GRPC_ALARM_SEVERITY_VALUES[child]
      : normalizeProtoModel(child);
  }
  return normalized;
}

export function restoreIntegerChoiceDefaults(value: any): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(restoreIntegerChoiceDefaults);
    return;
  }

  const choices = value.int32_choice?.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (choice.value === undefined) choice.value = 0;
    }
  }

  if (value.commands && typeof value.commands === 'object') {
    for (const command of Object.values(value.commands) as Array<Record<string, any>>) {
      command.response ??= false;
    }
  }

  Object.values(value).forEach(restoreIntegerChoiceDefaults);
}

export function restoreGrpcComponentDefaults(value: any): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(restoreGrpcComponentDefaults);
    return;
  }
  for (const range of [value.int32_range, value.float_range]) {
    if (range && typeof range === 'object') {
      range.min_value ??= 0;
      range.max_value ??= 0;
    }
  }
  if (value.alarm_table && typeof value.alarm_table === 'object') {
    value.alarm_table.alarms ??= [];
    if (Array.isArray(value.alarm_table.alarms)) {
      for (const alarm of value.alarm_table.alarms) {
        if (alarm && typeof alarm === 'object') {
          alarm.bit_value ??= 0;
          alarm.severity ??= 0;
        }
      }
    }
  }
  Object.values(value).forEach(restoreGrpcComponentDefaults);
}

export function restoreGrpcDescriptorDefaults(model: Record<string, any>): void {
  const restoreParamMap = (paramMap: any) => {
    if (!paramMap || typeof paramMap !== 'object' || Array.isArray(paramMap)) return;
    for (const descriptor of Object.values(paramMap) as Array<Record<string, any>>) {
      if (!descriptor || typeof descriptor !== 'object') continue;
      descriptor.read_only ??= false;
      if (descriptor.params) restoreParamMap(descriptor.params);
    }
  };

  restoreParamMap(model.params);
  if (model.commands && typeof model.commands === 'object') {
    for (const command of Object.values(model.commands) as Array<Record<string, any>>) {
      if (!command || typeof command !== 'object') continue;
      command.read_only ??= false;
      command.response ??= false;
      if (command.params) restoreParamMap(command.params);
    }
  }
}
