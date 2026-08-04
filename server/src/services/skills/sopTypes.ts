export interface SopASTInput {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

export interface SopASTStep {
  stepNumber: number;
  action: string;
  targetSystem?: string;
  condition?: string;
  onSuccessNextStep?: number;
  onFailureNextStep?: number;
  requiresHumanApproval: boolean;
}

export interface SopAST {
  id: string;
  title: string;
  triggerCondition: string;
  requiredInputs: SopASTInput[];
  steps: SopASTStep[];
}
