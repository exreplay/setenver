import { Command, CommandInterface } from './command';
import { relative, resolve } from 'path';
import { globbySync } from 'globby';
import prompts, { Answers, PromptObject } from 'prompts';
import { writeFile, readFile } from 'fs/promises';
import { Variable, VariableType, Files } from '../types';

// parse-gitignore is a commonjs module so we need to import it like this
import parseGitignore from 'parse-gitignore';
const { parse } = parseGitignore;

export class ExamplesCommand extends Command implements CommandInterface {
  name = 'examples';
  description = 'Create .env from .env.example files';

  files: Files = {};
  noGitignore = false;

  constructor(private root: string) {
    super();

    if (this.argv.gitignore === false) {
      this.noGitignore = true;
    }
  }

  async run() {
    if (!(await super.run())) return;

    const selectedFiles = await this.selectFiles();
    if (!selectedFiles.length) {
      console.log('No files selected. Exiting...');
      return;
    }

    await this.parseFiles(selectedFiles);

    const questions = this.generateQuestions();
    for (const [file, question] of Object.entries(questions)) {
      if (question) {
        console.log(relative(this.root, file));

        const answers = await prompts(question, {
          onCancel: () => process.exit(0)
        });

        this.setAnswers(file, answers);
      }
    }

    const files = this.prepareEnvFilesContent();
    for (const { file, contents } of files) {
      await writeFile(file, contents);
    }

    return true;
  }

  async collectFiles() {
    const ignore = await this.parseGitignore();
    return globbySync(`${this.root}/**/.env.example`, {
      ignore: this.noGitignore ? [] : ignore
    });
  }

  async parseGitignore() {
    const gitignore = resolve(this.root, '.gitignore');
    const gitignoreContent = await readFile(gitignore, 'utf-8');
    const { globs } = parse(gitignoreContent);
    return globs().flatMap((e) =>
      e.type === 'ignore' ? e.patterns : e.patterns
    );
  }

  async selectFiles() {
    const collectedFiles = await this.collectFiles();

    const { files } = await prompts({
      type: 'multiselect',
      name: 'files',
      message: 'Select files to parse',
      choices: collectedFiles.map((file) => ({
        title: relative(this.root, file),
        value: file,
        selected: true
      }))
    });

    return files as string[];
  }

  parseContent(content: string) {
    const lines = content.split('\n');
    const variables: Variable[] = [];

    for (const line of lines) {
      if (line.startsWith('#')) {
        variables.push({
          defaultValue: line,
          type: VariableType.COMMENT
        });
      } else if (line === '') {
        variables.push({
          defaultValue: line,
          type: VariableType.NEW_LINE
        });
      } else {
        const [variable, value] = line.split('=');

        variables.push({
          key: variable,
          defaultValue: value,
          type: VariableType.VARIABLE
        });
      }
    }

    return variables;
  }

  async parseFiles(files: string[]) {
    for (const file of files) {
      const content = await readFile(file, 'utf-8');
      this.files[file] = this.parseContent(content);
    }
  }

  generateQuestions() {
    const questions: { [filename: string]: PromptObject[] | undefined } = {};

    for (const [file, variables] of Object.entries(this.files)) {
      for (let i = 0; i < variables.length; i++) {
        const variable = variables[i];
        if (variable.type !== VariableType.VARIABLE) continue;

        if (!questions[file]) questions[file] = [];

        questions[file].push({
          type: 'text',
          name: i.toString(),
          message: variable.key,
          initial: variable.defaultValue
        });
      }
    }

    return questions;
  }

  setAnswers(file: string, answers: Answers<string>) {
    for (const [key, answer] of Object.entries(answers)) {
      const parsedKey = parseInt(key, 10);

      if (this.files[file][parsedKey]) {
        this.files[file][parsedKey].value = answer;
      }
    }
  }

  prepareEnvFilesContent() {
    const files: { file: string; contents: string }[] = [];

    for (const [file, variables] of Object.entries(this.files)) {
      let fileContent = '';

      for (const variable of variables) {
        if (variable.type === VariableType.VARIABLE) {
          fileContent += `${variable.key}=${
            variable.value || variable.defaultValue
          }\n`;
        } else if (variable.type === VariableType.COMMENT) {
          fileContent += `${variable.defaultValue}\n`;
        } else if (variable.type === VariableType.NEW_LINE) {
          fileContent += '\n';
        }
      }

      files.push({
        file: file.replace('.example', ''),
        contents: fileContent
      });
    }

    return files;
  }
}
