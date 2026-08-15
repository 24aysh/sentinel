This spec file focuses on the output guardrails.
This guardrail forces the model to response to a conformed schema, ie a JSON object (if this output guardrail is enabled).

the flow should be like user should define a json object along with the yaml policy and the gateway should force the output to the given JSON schema, if the schema is valid. Otherwise we should log a valid response saying that the schema was malformed  and couldn't be accepted.
