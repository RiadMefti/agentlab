const BEDROCK_ARN_PREFIX =
  "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/deployment-";

export const LONG_BEDROCK_MODEL_ID = BEDROCK_ARN_PREFIX.padEnd(2_048, "x");
export const LONG_OPENCODE_BEDROCK_MODEL_ID = `amazon-bedrock/${LONG_BEDROCK_MODEL_ID}`;
