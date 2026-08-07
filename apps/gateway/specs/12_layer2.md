In this part, we are building another layer to detect prompt injections

The workflow will be like, first the input guardrails detect for PII,if there no PII leaks, then the request goes for prompt injection detection.

Working of prompt injection detection.
I plan to use open sourced data sets and use them to detect PI. I will datasets from huggingface. I don't know how to use the datasets from hugging face into my project. Its my first time so you have guide me through this.

Also there is something called canary tokens. Canary tokens: Add canary tokens to prompts to detect leakages, allowing the framework to store embeddings about the incoming prompt in the vector database and prevent future attacks. Explain me these too and tell whether they can be useful or not in this layer


I have 3-4 datasets, and i plan to use all of them, maybe curate into them into a single dataset and use it then. Curating them into single database is just an option if i can't use them independently

Also tell how this dataset thing will help in detecting PI. Is it to similar to Store embeddings of previous attacks in a vector database to recognize and prevent similar attacks in the future? or datasets are something different. If yes, then how?