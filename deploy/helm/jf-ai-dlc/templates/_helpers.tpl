{{- define "jf.labels" -}}
app.kubernetes.io/part-of: jf-ai-dlc
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "jf.tables" -}}
{{- $p := .Values.naming.projectName -}}
{{- $e := .Values.naming.environment -}}
AGENT_OUTPUTS_TABLE: {{ printf "%s-agent-outputs-%s" $p $e | quote }}
BLOCKS_TABLE: {{ printf "%s-blocks-%s" $p $e | quote }}
CONNECTIONS_TABLE: {{ printf "%s-connections-%s" $p $e | quote }}
GIT_CONNECTIONS_TABLE: {{ printf "%s-%s-git-connections" $p $e | quote }}
GIT_PROVIDER_CONNECTIONS_TABLE: {{ printf "%s-%s-git-provider-connections" $p $e | quote }}
LOCKS_TABLE: {{ printf "%s-discussion-locks-%s" $p $e | quote }}
QUESTIONS_TABLE: {{ printf "%s-agent-questions-%s" $p $e | quote }}
READ_STATE_TABLE: {{ printf "%s-discussion-read-state-%s" $p $e | quote }}
SESSIONS_TABLE: {{ printf "%s-sessions-%s" $p $e | quote }}
NOTIFICATIONS_TABLE: {{ printf "%s-notifications-%s" $p $e | quote }}
SOURCE_CONTROL_BINDINGS_TABLE: {{ printf "%s-%s-source-control-bindings" $p $e | quote }}
TRACKER_CONNECTIONS_TABLE: {{ printf "%s-%s-tracker-connections" $p $e | quote }}
YJS_DOCUMENTS_TABLE: {{ printf "%s-yjs-documents-%s" $p $e | quote }}
V2_PROCESS_TABLE: {{ printf "%s-v2-executions-%s" $p $e | quote }}
{{- end -}}
