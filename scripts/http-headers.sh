#!/usr/bin/env bash

normalize_http_response() {
  printf '%s' "${1//$'\r'/}"
}
