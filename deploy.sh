#!/bin/bash
# Run this locally to push updates to the VPS
set -e
git push origin main
sshpass -p 'Sivaprakasam@1981' ssh -o StrictHostKeyChecking=no root@31.97.56.148 '/root/ninjapa/deploy.sh'
