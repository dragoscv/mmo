#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10024 dragos@127.0.0.1"
$SSH 'getent passwd dragos | cut -d: -f7; echo "==WHOAMI=="; whoami; echo "==WHICH BASH=="; which bash'
