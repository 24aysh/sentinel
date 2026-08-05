You are building a model-agnostic policy-enforcement gateway that evaluates prompts, retrieved data, model responses and tool calls against versioned policies, then allows, transforms, blocks, retries, routes or escalates each operation

This is the first bit you are implementing. This focusses on defining the simplest useful gateway behavior: accepting an LLM request, processing it through a fixed lifecycle, forwarding it to a model, and returning the result.

You don't enforce any guardrails here, this is just to check that the gateway is working as expected. We will add guardrails at a later stage of the project. So do not enforce any guardrails here

So what i want you to build is a simple gateway that accepts an LLM request, processing it through a fixed lifecycle, forwarding it to a model, and returning the result. I also want some test scripts to be made to check that uses the gateway pipeline to check whether gateway is able to process user requests or not. Don't worry about the api keys,you may create one .env.example and i will make the actual env while checking. Maintain a well structured backend for easy maintainance too 

If you need any more info, ask it before the final implementation