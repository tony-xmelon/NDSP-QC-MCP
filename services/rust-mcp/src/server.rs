use crate::{ACTIONS, ActionSpec, BackendError, Classification, PrincipalRoute, QcBackend};
use axum::Router;
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListResourcesResult, ListToolsResult, PaginatedRequestParams, ReadResourceRequestParams,
        ReadResourceResponse, ReadResourceResult, Resource, ResourceContents, ServerCapabilities,
        ServerInfo, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde_json::{Map, Value, json};
use std::sync::Arc;

const INSTRUCTIONS: &str = "Inspect qc://current-preset before changing the device. Every mutation uses expected-state values from a fresh snapshot. Persistent and risky operations require explicit confirmation flags. Never invent expected values.";

#[derive(Clone)]
pub struct QcMcp {
    backend: Arc<dyn QcBackend>,
}

impl QcMcp {
    pub fn new(backend: Arc<dyn QcBackend>) -> Self {
        Self { backend }
    }

    pub fn tools(&self) -> Vec<Tool> {
        ACTIONS.iter().map(ActionSpec::tool).collect()
    }

    pub async fn execute(
        &self,
        route: &PrincipalRoute,
        name: &str,
        arguments: Option<Map<String, Value>>,
    ) -> Result<Value, String> {
        let spec = ACTIONS
            .iter()
            .find(|a| a.name == name)
            .ok_or_else(|| format!("unknown tool: {name}"))?;
        let mut args = arguments.unwrap_or_default();
        validate(spec, &args)?;
        apply_confirmation_gate(spec, &mut args)?;
        let params = gateway_params(spec, args);
        self.backend
            .request(route, spec.rpc, params)
            .await
            .map_err(|e| e.to_string())
    }
}

impl ServerHandler for QcMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(Implementation::new(
            "NDSP Quad Cortex",
            env!("CARGO_PKG_VERSION"),
        ))
        .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(self.tools()))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        ACTIONS
            .iter()
            .find(|a| a.name == name)
            .map(ActionSpec::tool)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let route = match principal_route(&context) {
            Ok(route) => route,
            Err(message) => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(message)]).into());
            }
        };
        match self
            .execute(&route, request.name.as_ref(), request.arguments)
            .await
        {
            Ok(value) => Ok(CallToolResult::structured(value).into()),
            Err(message) if message.starts_with("unknown tool:") => {
                Err(McpError::invalid_params(message, None))
            }
            Err(message) => Ok(CallToolResult::error(vec![ContentBlock::text(message)]).into()),
        }
    }

    async fn list_resources(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        Ok(ListResourcesResult::with_all_items(vec![
            resource(
                "qc://status",
                "status",
                "Connection and gateway capability status.",
            ),
            resource(
                "qc://current-preset",
                "current-preset",
                "Authoritative preset, scene, blocks, tempo, mode and dirty state.",
            ),
            resource(
                "qc://models",
                "models",
                "Installed models available on the paired Quad Cortex.",
            ),
        ]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        let rpc = match request.uri.as_str() {
            "qc://status" => "system.status",
            "qc://current-preset" => "device.snapshot",
            "qc://models" => "device.listModels",
            _ => return Err(McpError::invalid_params("unknown QC resource", None)),
        };
        let route =
            principal_route(&context).map_err(|message| McpError::invalid_params(message, None))?;
        match self.backend.request(&route, rpc, Map::new()).await {
            Ok(value) => Ok(ReadResourceResult::new(vec![ResourceContents::text(
                value.to_string(),
                request.uri,
            )])
            .into()),
            Err(error) => Err(backend_protocol_error(error)),
        }
    }
}

fn resource(uri: &str, name: &str, description: &str) -> Resource {
    Resource::new(uri, name)
        .with_description(description)
        .with_mime_type("application/json")
}

fn backend_protocol_error(error: BackendError) -> McpError {
    McpError::internal_error(
        error.message,
        Some(json!({"code":error.code,"retryable":error.retryable})),
    )
}

fn principal_route(context: &RequestContext<RoleServer>) -> Result<PrincipalRoute, String> {
    context
        .extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.extensions.get::<PrincipalRoute>())
        .cloned()
        .ok_or_else(|| "authenticated principal/device route is required".into())
}

/// Mount this behind the authentication/authorization middleware. The service is
/// intentionally not a runnable unauthenticated binary and does not terminate TLS.
pub fn mcp_router<F>(make_handler: F) -> Router
where
    F: Fn() -> Result<QcMcp, std::io::Error> + Clone + Send + Sync + 'static,
{
    let service = StreamableHttpService::new(
        make_handler,
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    Router::new().route_service("/mcp", service)
}

fn validate(spec: &ActionSpec, args: &Map<String, Value>) -> Result<(), String> {
    for key in args.keys() {
        if !spec.properties.iter().any(|p| p.name == key) {
            return Err(format!("unexpected argument: {key}"));
        }
    }
    for p in spec.properties {
        let Some(value) = args.get(p.name) else {
            if p.required {
                return Err(format!("{} is required", p.name));
            }
            continue;
        };
        use crate::actions::Kind;
        let valid = match p.kind {
            Kind::String => value.as_str().is_some_and(|s| !s.trim().is_empty()),
            Kind::VisibleString { max_chars } => value.as_str().is_some_and(|s| {
                !s.trim().is_empty()
                    && s.chars().count() <= max_chars
                    && !s.chars().any(char::is_control)
            }),
            Kind::NullableString => value.is_null() || value.is_string(),
            Kind::NullableInteger { min, max } => {
                value.is_null()
                    || value
                        .as_i64()
                        .is_some_and(|n| n >= min && max.is_none_or(|m| n <= m))
            }
            Kind::Boolean => value.is_boolean(),
            Kind::Integer { min, max } => value
                .as_i64()
                .is_some_and(|n| n >= min && max.is_none_or(|m| n <= m)),
            Kind::Number { min, max } => value
                .as_f64()
                .is_some_and(|n| n >= min && max.is_none_or(|m| n <= m)),
        };
        if !valid {
            return Err(format!("invalid {}", p.name));
        }
    }
    if spec.name == "navigate_bank"
        && !matches!(args.get("direction").and_then(Value::as_i64), Some(-1 | 1))
    {
        return Err("direction must be -1 or 1".into());
    }
    Ok(())
}

fn apply_confirmation_gate(spec: &ActionSpec, args: &mut Map<String, Value>) -> Result<(), String> {
    let required = match spec.classification {
        Classification::PersistentWrite => Some("confirm_persistent_write"),
        Classification::RiskyWrite => Some("confirm_risky_operation"),
        _ => None,
    };
    if let Some(flag) = required
        && args.remove(flag) != Some(Value::Bool(true))
    {
        return Err(format!(
            "{flag}=true is required after explicit user confirmation"
        ));
    }
    Ok(())
}

fn gateway_params(spec: &ActionSpec, args: Map<String, Value>) -> Map<String, Value> {
    args.into_iter()
        .filter_map(|(key, value)| {
            let nullable_integer = spec.properties.iter().any(|property| {
                property.name == key
                    && matches!(property.kind, crate::actions::Kind::NullableInteger { .. })
            });
            if value.is_null() && !nullable_integer {
                return None;
            }
            // list_models.query is an MCP-side discovery convenience; the current
            // gateway's device.listModels method intentionally accepts no params.
            if spec.name == "list_models" && key == "query" {
                return None;
            }
            let gateway_key = match (spec.name, key.as_str()) {
                ("rename_current_preset", "new_name") => "name".into(),
                _ => snake_to_camel(&key),
            };
            Some((gateway_key, value))
        })
        .chain(
            (spec.name == "rename_current_preset")
                .then(|| ("confirmRename".into(), Value::Bool(true))),
        )
        .collect()
}

fn snake_to_camel(value: &str) -> String {
    let mut output = String::new();
    let mut upper = false;
    for c in value.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            output.extend(c.to_uppercase());
            upper = false;
        } else {
            output.push(c);
        }
    }
    output
}
