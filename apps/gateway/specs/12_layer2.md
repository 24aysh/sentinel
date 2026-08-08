In this part, we are building another layer to detect prompt injections

The workflow will be like, first the input guardrails detect for PII,if there no PII leaks, then the request goes for prompt injection detection.  There is no redact for PI, just allow or block.

Working of prompt injection detection.
I plan to use open sourced data sets and use them to detect PI. I will datasets from huggingface. I don't know how to use the datasets from hugging face into my project. Its my first time so you have guide me through this.


I have 3-4 datasets, and i plan to use all of them, maybe curate into them into a single dataset and use it then. Curating them into single database is just an option if i can't use them independently. You can use python for offline training of the model  and then we will just import them in our typescript code. You may create seperate directory for the training version. I plan to use kaggle for the model learning as its my first time training a model so i want to get familiar with kaggle. I don't know much about this so you have to explain and every aspect of this part

I want you to plan me above the layer in 2 parts, the model training part and then using that trained model in our project. Also I don't have any idea which open sourced model to train so you have look for that also in our particular usecase.

The datasets i'll be using are available on huggingface. Below are their addresses
 - rogue-security/prompt-injections-benchmark
 - xxz224/prompt-injection-attack-dataset
 - jayavibhav/prompt-injection-safety
 - jayavibhav/prompt-injection

Also i'll be using free plan for huggingface and kaggle, and so guide me accordingly. And also what would be the estimated time to train the model. 