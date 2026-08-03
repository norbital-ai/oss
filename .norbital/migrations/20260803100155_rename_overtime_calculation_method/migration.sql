-- Custom SQL migration file, put your code below! --
UPDATE "companies"
SET "overtime_calculation_method" = 'ANNUALISED_CONTRACT_RATE'
WHERE "overtime_calculation_method" = 'INFOTECH_ANNUALISED_DATED';
