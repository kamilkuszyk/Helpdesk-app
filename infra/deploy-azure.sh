#!/usr/bin/env zsh
# =====================================================================
# Helpdesk - wdrożenie infrastruktury w Azure (L4)
# Uruchamiane krok po kroku w Terminalu (zsh, macOS) po `az login`.
# Hasła NIE są zapisane w pliku - skrypt pyta o nie interaktywnie.
# =====================================================================
set -e

RG=rg-helpdesk
LOC=norwayeast                 # region (B1ms + VNet niedostępne w Poland/Sweden Central dla subskrypcji studenckiej)
VNET=vnet-helpdesk-no
DB=psql-helpdesk-no
ACR_NAME=acrhelpdeskkk         # rejestr w Poland Central (pobieranie obrazów między regionami działa)
ENV=cae-helpdesk
APP=ca-helpdesk

read -s "PGPASS?Hasło administratora bazy: "; echo
read -s "DEMOPASS?Hasło kont testowych aplikacji: "; echo

# --- 1. Grupa zasobów i rejestr obrazów -----------------------------
az group create -n $RG -l polandcentral
az acr create -g $RG -n $ACR_NAME -l polandcentral --sku Standard \
  --dnl-scope TenantReuse      # unikalny dopisek w adresie (ochrona przed przejęciem nazwy)
ACR=$(az acr show -n $ACR_NAME --query loginServer -o tsv)

# --- 2. Obraz aplikacji (Mac ARM -> serwery x86) ----------------------
az acr login -n $ACR_NAME
docker buildx build --platform linux/amd64 -t $ACR/helpdesk:1.0 --push .

# --- 3. Sieć wirtualna -----------------------------------------------
az network vnet create -g $RG -n $VNET -l $LOC --address-prefixes 10.0.0.0/16
az network vnet subnet create -g $RG --vnet-name $VNET -n snet-apps \
  --address-prefixes 10.0.0.0/23 --delegations Microsoft.App/environments
az network vnet subnet create -g $RG --vnet-name $VNET -n snet-db \
  --address-prefixes 10.0.2.0/24 --private-endpoint-network-policies Enabled

# --- 4. Baza PostgreSQL bez dostępu publicznego ----------------------
az postgres flexible-server create -g $RG -n $DB -l $LOC \
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
  --admin-user helpdeskadmin --admin-password "$PGPASS" \
  --public-access Disabled --yes
az postgres flexible-server db create -g $RG --server-name $DB --name helpdesk

# --- 5. Private Endpoint + prywatny DNS --------------------------------
DBID=$(az postgres flexible-server show -g $RG -n $DB --query id -o tsv)
az network private-endpoint create -g $RG -n pe-psql-helpdesk -l $LOC \
  --vnet-name $VNET --subnet snet-db \
  --private-connection-resource-id $DBID --group-id postgresqlServer --connection-name pe-psql-conn
az network private-dns zone create -g $RG -n privatelink.postgres.database.azure.com
az network private-dns link vnet create -g $RG -z privatelink.postgres.database.azure.com \
  -n link-$VNET -v $VNET -e false
az network private-endpoint dns-zone-group create -g $RG --endpoint-name pe-psql-helpdesk \
  -n default --private-dns-zone privatelink.postgres.database.azure.com --zone-name postgres

# --- 6. Firewall (NSG) podsieci bazy: tylko podsieć aplikacji na 5432 --
az network nsg create -g $RG -n nsg-snet-db -l $LOC
az network nsg rule create -g $RG --nsg-name nsg-snet-db -n allow-apps-postgres --priority 100 \
  --direction Inbound --access Allow --protocol Tcp \
  --source-address-prefixes 10.0.0.0/23 --destination-port-ranges 5432
az network nsg rule create -g $RG --nsg-name nsg-snet-db -n deny-all-inbound --priority 4000 \
  --direction Inbound --access Deny --protocol '*' \
  --source-address-prefixes '*' --destination-port-ranges '*'
az network vnet subnet update -g $RG --vnet-name $VNET -n snet-db --network-security-group nsg-snet-db

# --- 7. Container Apps: load balancer (ingress) + TLS + autoskalowanie --
az extension add --name containerapp --upgrade -y
SUBNET_ID=$(az network vnet subnet show -g $RG --vnet-name $VNET -n snet-apps --query id -o tsv)
az containerapp env create -g $RG -n $ENV -l $LOC --infrastructure-subnet-resource-id $SUBNET_ID

az containerapp create -g $RG -n $APP --environment $ENV \
  --image $ACR/helpdesk:1.0 \
  --ingress external --target-port 3000 \
  --min-replicas 1 --max-replicas 3 \
  --scale-rule-name http-rule --scale-rule-type http --scale-rule-http-concurrency 10 \
  --cpu 0.25 --memory 0.5Gi --system-assigned \
  --secrets "database-url=postgres://helpdeskadmin:$PGPASS@$DB.postgres.database.azure.com:5432/helpdesk" \
            "session-secret=$(openssl rand -hex 32)" "demo-password=$DEMOPASS" \
  --env-vars DATABASE_URL=secretref:database-url SESSION_SECRET=secretref:session-secret \
             DEMO_PASSWORD=secretref:demo-password DB_SSL=true COOKIE_SECURE=true TRUST_PROXY=1 || true

# Rola AcrPull dla tożsamości aplikacji (tylko pobieranie obrazów - least privilege).
# Ręcznie, bo CLI nie rozpoznaje rejestru z dopiskiem TenantReuse.
PRINCIPAL=$(az containerapp show -g $RG -n $APP --query identity.principalId -o tsv)
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
  --scope $(az acr show -n $ACR_NAME --query id -o tsv) --role AcrPull
sleep 60
az containerapp registry set -g $RG -n $APP --server $ACR --identity system
az containerapp update -g $RG -n $APP --image $ACR/helpdesk:1.0 --revision-suffix v2

echo "Adres aplikacji: https://$(az containerapp show -g $RG -n $APP --query properties.configuration.ingress.fqdn -o tsv)"
