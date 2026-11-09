{{/* Names and labels shared by every resource of the release. */}}
{{- define "ai-gateway.name" -}}
{{- printf "%s" .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "ai-gateway.labels" -}}
app.kubernetes.io/name: ai-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "ai-gateway.selector" -}}
app.kubernetes.io/name: ai-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Whether a separate worker Deployment runs (a worker image is set). */}}
{{- define "ai-gateway.separateWorker" -}}
{{- if .Values.image.worker.repository -}}true{{- end -}}
{{- end -}}

{{/* Settings both processes read: the Secret, the models file and extra values. */}}
{{- define "ai-gateway.env" -}}
- name: MODELS_CONFIG_PATH
  value: /etc/ai-gateway/models.json
{{- range $name, $value := .Values.env }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
{{- end -}}
