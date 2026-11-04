.PHONY: up cluster image load deploy down
IMAGE ?= marveen:dev
ROOT  := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)

up: cluster image load deploy ## build and run everything in kind
cluster:
	kind get clusters | grep -qx marveen || kind create cluster --config $(ROOT)/deploy/kind/kind-config.yaml
image:
	docker build -f $(ROOT)/deploy/docker/Dockerfile -t $(IMAGE) $(ROOT)
load:
	kind load docker-image $(IMAGE) --name marveen
deploy:
	helm upgrade --install marveen $(ROOT)/deploy/helm/marveen $(if $(SECRET),--set existingSecret=$(SECRET))
	kubectl rollout restart deployment/marveen
down:
	kind delete cluster --name marveen
