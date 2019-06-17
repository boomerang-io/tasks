#!/bin/bash

KUBE_HOME=/opt/bin
KUBE_CLI=$KUBE_HOME/kubectl
KUBE_FILE=$1
DEPLOY_KUBE_NAMESPACE=$2

echo "Configuring Kubernetes..."
KUBE_HOME=/opt/bin
KUBE_CLI=$KUBE_HOME/kubectl
KUBE_CLI_VERSION=v1.10.2

# Relies on proxy settings coming through if there is a proxy
# TODO: Update URL to https://helm.sh/blog/get-helm-sh/
curl -L https://storage.googleapis.com/kubernetes-release/release/$KUBE_CLI_VERSION/bin/linux/amd64/kubectl -o $KUBE_CLI && chmod +x $KUBE_CLI

KUBE_NAMESPACE=$DEPLOY_KUBE_NAMESPACE
export KUBE_CLUSTER_HOST=wdc3.cloud.boomerangplatform.net #needed for deploy step
KUBE_CLUSTER_IP=10.190.20.176
KUBE_CLUSTER_PORT=8001
KUBE_TOKEN=***REMOVED***

$KUBE_CLI config set-cluster $KUBE_CLUSTER_HOST --server=https://$KUBE_CLUSTER_IP:$KUBE_CLUSTER_PORT --insecure-skip-tls-verify=true
$KUBE_CLI config set-context $KUBE_CLUSTER_HOST-context --cluster=$KUBE_CLUSTER_HOST
$KUBE_CLI config set-credentials $KUBE_CLUSTER_HOST-user --token=$KUBE_TOKEN
$KUBE_CLI config set-context $KUBE_CLUSTER_HOST-context --user=$KUBE_CLUSTER_HOST-user --namespace=$KUBE_NAMESPACE
$KUBE_CLI config use-context $KUBE_CLUSTER_HOST-context
$KUBE_CLI apply -f $1