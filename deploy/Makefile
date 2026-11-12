.PHONY: up cluster image load deploy down
IMAGE ?= marveen:dev
ROOT  := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)

up: cluster image load deploy ## build and run everything in kind
cluster:
	kind get clusters | grep -qx marveen || kind create cluster --config $(ROOT)/deploy/kind/kind-config.yaml
image:
	docker build -t $(IMAGE) $(ROOT)
load:
	kind load docker-image $(IMAGE) --name marveen
deploy:
	helm --kube-context kind-marveen upgrade --install marveen $(ROOT)/deploy/helm/marveen --set image.repository=$(firstword $(subst :, ,$(IMAGE))) --set image.tag=$(lastword $(subst :, ,$(IMAGE))) $(if $(SECRET),--set existingSecret=$(SECRET))
	kubectl --context kind-marveen rollout restart deployment/marveen
down:
	kind delete cluster --name marveen
