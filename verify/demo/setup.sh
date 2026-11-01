#!/usr/bin/env bash
# Lays out the sandbox the README's demo is recorded in (verify/demo/record.py).
#
# Two throwaway k3d clusters, handrail-staging and handrail-production, as the
# contexts staging and production (production current), a Secret with fake
# values, and a small project whose deploy script takes the ambient
# kube-context. Everything goes under $DEMO (default /tmp/handrail-demo); your
# own kubeconfig is neither read nor changed.
set -euo pipefail
DEMO="${DEMO:-/tmp/handrail-demo}"
mkdir -p "$DEMO/shop/scripts" "$DEMO/shop/charts/api/templates"

for env in staging production; do
  k3d cluster create "handrail-$env" --kubeconfig-update-default=false --kubeconfig-switch-context=false --wait
  k3d kubeconfig get "handrail-$env" > "$DEMO/$env.yaml"
  kubectl --kubeconfig "$DEMO/$env.yaml" config rename-context "k3d-handrail-$env" "$env"
done
KUBECONFIG="$DEMO/staging.yaml:$DEMO/production.yaml" kubectl config view --flatten > "$DEMO/kubeconfig"
rm "$DEMO/staging.yaml" "$DEMO/production.yaml"
kube=(kubectl --kubeconfig "$DEMO/kubeconfig")
"${kube[@]}" config use-context production
"${kube[@]}" --context production create namespace shop
fake() { head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9'; }
"${kube[@]}" --context production --namespace shop create secret generic api \
  --from-literal=DATABASE_URL="postgres://app:demo-$(fake)@db.shop.svc:5432/app" \
  --from-literal=PAYMENT_KEY="demo-old-key-$(fake)"

cat > "$DEMO/shop/scripts/deploy.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
app="$1"
env="$2"
helm upgrade --install "$app" "./charts/$app" -f "values-$env.yaml"
EOF
chmod +x "$DEMO/shop/scripts/deploy.sh"
printf 'apiVersion: v2\nname: api\nversion: 0.4.2\n' > "$DEMO/shop/charts/api/Chart.yaml"
printf 'replicas: 1\nimage: shop/api:1.8.0\n' > "$DEMO/shop/values-staging.yaml"
printf 'replicas: 4\nimage: shop/api:1.7.3\n' > "$DEMO/shop/values-production.yaml"
cat > "$DEMO/shop/CLAUDE.md" <<'EOF'
# shop

Deploy an app with `./scripts/deploy.sh <app> <env>`, where `<env>` is `staging` or `production`.

Keep replies short: two sentences at most.
EOF

# The session reads only these settings (record.py passes --setting-sources
# project,local): English replies, no Remote Control, the band showing kube only.
cat > "$DEMO/settings.json" <<'EOF'
{
  "language": "English",
  "remoteControlAtStartup": false,
  "enabledPlugins": { "infra-handrail@jerrytech": false },
  "pluginConfigs": { "infra-handrail": { "options": { "targets": "kube" } } },
  "permissions": {
    "allow": ["Bash(./scripts/deploy.sh:*)", "mcp__infra-handrail__secret_set", "mcp__infra-handrail__secret_keys"]
  }
}
EOF
printf 'set -g default-terminal tmux-256color\nset -as terminal-features ",*:RGB"\n' > "$DEMO/tmux.conf"

echo "Sandbox ready in $DEMO. Record with: python3 verify/demo/record.py"
# k3d removes a deleted cluster from the kubeconfig KUBECONFIG names, else from yours.
echo "When done: tmux -L handrail-demo kill-server; KUBECONFIG=$DEMO/kubeconfig k3d cluster delete handrail-staging handrail-production; rm -rf $DEMO"
