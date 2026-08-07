{{/*
Company Brain standard names: render the release-qualified name used by
all template metadata. Restores the helper the templates already reference
(the chart previously failed `helm template` with "undefined _helpers.tpl").
*/}}
{{- define "company-brain.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Company Brain component name: the fullname plus a component suffix, truncated
to 63 characters so every generated name AND label value stays within the
Kubernetes limit. Usage:
  {{ include "company-brain.component" (merge (dict "suffix" "postgres") .) }}
*/}}
{{- define "company-brain.component" -}}
{{- printf "%s-%s" (include "company-brain.fullname" .) (default "" .suffix) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
