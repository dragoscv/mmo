#!/bin/bash
for i in $(seq 1 30); do
  echo "try $i"
  if nc -zv 127.0.0.1 10022 2>&1 | grep -q succeeded; then
    echo READY
    exit 0
  fi
  sleep 10
done
exit 1
